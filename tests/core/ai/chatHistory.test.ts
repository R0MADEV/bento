import { describe, expect, it } from 'vitest'
import { GLOBAL_CHAT_CONVERSATION, parseChatHistory, pinnedFollowUpHistory, serializeChatHistory, techReviewConversationKey } from '../../../src/core/ai/chatHistory'
import type { ChatMessage } from '../../../src/core/ai/config'

describe('chat history', () => {
  it('migrates the legacy global message array', () => {
    const state = parseChatHistory('[{"role":"user","content":"hello"}]')

    expect(state.activeConversation).toBe(GLOBAL_CHAT_CONVERSATION)
    expect(state.conversations.global).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('keeps independent persisted conversations', () => {
    const raw = serializeChatHistory({
      version: 2,
      activeConversation: 'tech-review:/repo:feat/a',
      conversations: {
        global: [{ role: 'user', content: 'general' }],
        'tech-review:/repo:feat/a': [{ role: 'assistant', content: 'review' }],
      },
      contexts: {
        'tech-review:/repo:feat/a': {
          projectPath: '/repo',
          agentType: 'claude',
          title: 'repo · feat/a',
          branch: 'feat/a',
          commit: '1111111111111111111111111111111111111111',
          sessionId: 'session-review-1',
          sessionAgent: 'claude',
          sessionCommit: '1111111111111111111111111111111111111111',
          evidence: ['Read: src/main.ts'],
        },
      },
    })

    const parsed = parseChatHistory(raw)
    expect(parsed.conversations['tech-review:/repo:feat/a'][0].content).toBe('review')
    expect(parsed.contexts['tech-review:/repo:feat/a']).toEqual({
      projectPath: '/repo',
      agentType: 'claude',
      title: 'repo · feat/a',
      branch: 'feat/a',
      commit: '1111111111111111111111111111111111111111',
      sessionId: 'session-review-1',
      sessionAgent: 'claude',
      sessionCommit: '1111111111111111111111111111111111111111',
      evidence: ['Read: src/main.ts'],
    })
  })

  it('normalizes Windows paths in Tech Review conversation keys', () => {
    expect(techReviewConversationKey('D:\\work\\repo\\', 'feat/a')).toBe('tech-review:D:/work/repo:feat/a')
  })
})

describe('pinnedFollowUpHistory', () => {
  const msg = (n: number): ChatMessage => ({ role: n === 0 ? 'assistant' : 'user', content: `m${n}` })

  it('returns the full history unchanged when it is short', () => {
    const full = [msg(0), msg(1), msg(2)]
    expect(pinnedFollowUpHistory(full, true)).toEqual(full)
  })

  it('returns the full history unchanged when there is no branch, regardless of length', () => {
    const full = Array.from({ length: 30 }, (_, i) => msg(i))
    expect(pinnedFollowUpHistory(full, false)).toEqual(full)
  })

  it('pins the first assistant message (the review report) when the branch history grows past 20', () => {
    const full = Array.from({ length: 30 }, (_, i) => msg(i))
    const result = pinnedFollowUpHistory(full, true)

    expect(result[0]).toEqual(msg(0))
    expect(result.slice(1)).toEqual(full.slice(-19))
  })

  it('does not duplicate the report when it already falls within the recent window', () => {
    const full = [msg(1), ...Array.from({ length: 29 }, (_, i) => msg(i + 10)), msg(0)]
    const result = pinnedFollowUpHistory(full, true)

    expect(result).toEqual(full.slice(-20))
  })
})
