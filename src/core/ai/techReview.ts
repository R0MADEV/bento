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

export interface ContextSnippet {
  path: string
  content: string
  reason: 'changed' | 'reference' | 'test' | 'definition'
}

export interface ContextInput {
  repoRoot: string
  diff: string
  changedFiles: string[]
}

export interface ContextResult {
  snippets: ContextSnippet[]
  sources: ContextSource[]
  lexisAvailable: boolean
}

export interface ContextProvider {
  collect(input: ContextInput): Promise<ContextResult>
}

export interface ContextProviderDependencies {
  lexis?: (input: ContextInput) => Promise<ContextSnippet[]>
  git?: (input: ContextInput) => Promise<ContextSnippet[]>
  direct: (input: ContextInput) => Promise<ContextSnippet[]>
}

export function createContextProvider(dependencies: ContextProviderDependencies): ContextProvider {
  return {
    async collect(input): Promise<ContextResult> {
      const snippets: ContextSnippet[] = []
      const sources: ContextSource[] = []
      let lexisAvailable = false
      if (dependencies.lexis) {
        try {
          const result = await dependencies.lexis(input)
          if (result.length) { snippets.push(...result); sources.push('lexis'); lexisAvailable = true }
        } catch { /* fallback below */ }
      }
      if (dependencies.git) {
        try {
          const result = await dependencies.git(input)
          if (result.length) { snippets.push(...result); sources.push('git') }
        } catch { /* direct files remain the minimum context */ }
      }
      const direct = await dependencies.direct(input)
      snippets.push(...direct)
      sources.push('direct')
      return { snippets, sources: [...new Set(sources)], lexisAvailable }
    },
  }
}

export interface ReviewDocumentMeta {
  branch: string
  base: string
  commit: string
  compareAgents: boolean
  fallbackAgentLabel: string
}

// The full review markdown (header + each agent's report). Extracted so it can be
// rebuilt from partial runs too — a crashed/stopped review still yields a document.
export function buildReviewDocument(meta: ReviewDocumentMeta, runs: MultiAgentReviewRun[]): string {
  const agentsLine = meta.compareAgents
    ? `Agents: ${runs.map(run => run.label).join(' + ')}`
    : `Agent: ${runs[0]?.label ?? meta.fallbackAgentLabel}`
  const header = [
    `## Revisión: ${meta.branch}`,
    `Base: \`${meta.base}\` · Commit: \`${meta.commit.slice(0, 7)}\``,
    agentsLine,
  ].join('\n')
  const body = runs
    .filter(run => run.report || run.error)
    .map(run => {
      if (run.error) return `### ${run.label}\n⚠️ ${run.error}`
      // With one agent the report stands alone; with several, label each section.
      return meta.compareAgents ? `### ${run.label}\n${run.report}` : (run.report ?? '')
    })
  return [header, ...body].join('\n\n')
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

// Transient infra failures worth one retry. Deliberately NOT timeouts: a timeout
// means the work didn't fit the time window, so retrying just burns another one.
export function isRetryableReviewError(message: string): boolean {
  if (!message) return false
  if (/timeout|timed out/i.test(message)) return false
  return /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|\b503\b|\b502\b|connection|econnreset|network|socket hang up|temporar|exited with an error/i.test(message)
}
