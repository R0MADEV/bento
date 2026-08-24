import { invoke } from '@tauri-apps/api/core'
import { t as i18nT } from '../../i18n'
import type { ChatMessage } from '../../core/ai/config'
import type { ChatConversationContext } from '../../core/ai/chatHistory'

// Actualizar una conversación de Tech Review al último commit de su rama: hay
// que comprobar si se ha quedado atrás, preguntar, preparar el worktree y
// soltarlo al terminar. Vivía como un listener de 80 líneas dentro del chat.

interface ReviewBranchContextResult {
  path: string
  commit: string
  latestCommit: string
  managed: boolean
  stale: boolean
}

export interface BranchRefreshDeps {
  historyReady: Promise<unknown>
  isStreaming: () => boolean
  context: () => ChatConversationContext | undefined
  messages: () => ChatMessage[]
  persistHistory: () => void
  renderThread: () => void
  beginBusy: () => void
  endBusy: () => void
  sendToAgent: (text: string) => Promise<void>
  clearWorktreePath: () => void
  /// La conversación arranca de cero: sin sesión que reanudar y sin marca de rama atrasada.
  onBranchUpdated: () => void
}

export function buildBranchRefresh(deps: BranchRefreshDeps): () => void {
  const refreshBranch = (): void => {
    void (async () => {
      await deps.historyReady
      if (deps.isStreaming()) return
      const context = deps.context()
      if (!context?.branch) return
      deps.beginBusy()
      let managedBranchContext = false
      let managedBranchContextPath: string | null = null
      try {
        if (context.commit) {
          const checked = await invoke<ReviewBranchContextResult>('review_branch_context_check', {
            repoPath: context.projectPath,
            reference: context.branch,
            commit: context.commit,
          })
          managedBranchContext ||= checked.managed
          managedBranchContextPath = checked.managed ? checked.path : managedBranchContextPath
          if (checked.managed) {
            context.worktreePath = checked.path
            deps.persistHistory()
          }
          if (!checked.stale) {
            deps.messages().push({ role: 'assistant', content: i18nT('common.reviewBranchUpToDate', { branch: context.branch }) })
            deps.renderThread()
            deps.persistHistory()
            return
          }
          if (!window.confirm(i18nT('common.updateReviewedBranchQuestion', {
            branch: context.branch,
            old: context.commit.slice(0, 7),
            next: checked.latestCommit.slice(0, 7),
          }))) return
        }
        const previous = context.commit
        const updated = await invoke<ReviewBranchContextResult>('review_branch_context_update', {
          repoPath: context.projectPath,
          reference: context.branch,
        })
        managedBranchContext ||= updated.managed
        managedBranchContextPath = updated.managed ? updated.path : managedBranchContextPath
        if (updated.managed) {
          context.worktreePath = updated.path
          deps.persistHistory()
        }
        context.commit = updated.commit
        context.sessionId = undefined
        context.sessionAgent = undefined
        context.sessionCommit = undefined
        context.evidence = []
        deps.onBranchUpdated()
        deps.messages().push({
          role: 'assistant',
          content: previous
            ? i18nT('common.reviewBranchUpdated', { branch: context.branch, old: previous.slice(0, 7), next: updated.commit.slice(0, 7) })
            : i18nT('common.reviewBranchReady', { branch: context.branch, commit: updated.commit.slice(0, 7) }),
        })
        deps.renderThread()
        deps.persistHistory()
      } catch (error) {
        deps.messages().push({ role: 'assistant', content: `⚠️ ${error instanceof Error ? error.message : String(error)}` })
        deps.renderThread()
        deps.persistHistory()
      } finally {
        if (managedBranchContext && managedBranchContextPath) {
          await invoke('review_branch_context_release', {
            path: managedBranchContextPath,
          }).catch(() => {})
          deps.clearWorktreePath()
        }
        deps.endBusy()
      }
    })()
  }

  return refreshBranch
}
