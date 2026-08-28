import type { AgentType } from './config'

export type ContextSource = 'lexis' | 'git' | 'direct'

export interface MultiAgentReviewRun {
  label: string
  agent: AgentType
  sessionId?: string | null
  // Markdown report the agent returned (the review no longer round-trips JSON).
  report?: string
  error?: string
}

export interface ReviewCheckpoint {
  content: string
  commit: string
  branch: string
  sessionId?: string | null
  sessionAgent?: AgentType | null
}

// Guards against corrupt/legacy localStorage so a bad checkpoint never throws
// while restoring — worst case we just don't offer the saved review.
export function parseReviewCheckpoint(raw: string | null): ReviewCheckpoint | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ReviewCheckpoint>
    const hasBody = typeof value?.content === 'string' && value.content.length > 0
    const hasMeta = typeof value?.commit === 'string' && typeof value?.branch === 'string'
    if (!hasBody || !hasMeta) return null
    return {
      content: value.content as string,
      commit: value.commit as string,
      branch: value.branch as string,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
      sessionAgent: value.sessionAgent ?? null,
    }
  } catch {
    return null
  }
}
