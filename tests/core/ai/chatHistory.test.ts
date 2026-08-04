import { describe, expect, it } from 'vitest'
import { GLOBAL_CHAT_CONVERSATION, parseChatHistory, serializeChatHistory, techReviewConversationKey } from '../../../src/core/ai/chatHistory'

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
    })
  })

  it('normalizes Windows paths in Tech Review conversation keys', () => {
    expect(techReviewConversationKey('D:\\work\\repo\\', 'feat/a')).toBe('tech-review:D:/work/repo:feat/a')
  })
})
