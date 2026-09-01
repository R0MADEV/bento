import { renderMarkdown } from '../../core/notes/renderMarkdown'
import { askAi } from '../../ui/askAi'
import { techReviewCheckpointKey, techReviewConversationKey } from '../../core/ai/chatHistory'
import type { AgentType } from '../../core/ai/config'
import type { ReviewCheckpoint } from '../../core/ai/techReview'
import { reviewT } from './i18n'
import { deleteReviewCheckpoint, listReviewCheckpoints, loadReviewCheckpoint } from './reviewCheckpoints'
import { buildReviewHistory } from './reviewHistory'

interface DrawerDom {
  reviewDrawer: HTMLElement
  reviewDrawerMeta: HTMLElement
  reviewDrawerBody: HTMLElement
  /** Where "no saved review" is shown: next to the code, not in the drawer. */
  diffView: HTMLElement
}

interface DrawerDeps {
  getRepoPath: () => string
  getSelectedBranch: () => string
}

/// The third column's own behaviour: showing it, and what it shows — the
/// report of a review, or the list of the ones already saved.
export function buildReviewDrawerActions(dom: DrawerDom, deps: DrawerDeps): {
  showReviewDrawer: () => void
  hideReviewDrawer: () => void
  openSavedReview: () => Promise<void>
  showReviewHistory: () => Promise<void>
} {
  const showReviewDrawer = (): void => {
    dom.reviewDrawer.classList.remove('hidden')
    dom.reviewDrawer.classList.add('visible')
  }

  const hideReviewDrawer = (): void => {
    dom.reviewDrawer.classList.remove('visible')
    dom.reviewDrawer.classList.add('hidden')
  }

  // Shows a saved review and re-wires its follow-up chat, so a reopened review
  // can still be asked about.
  const showCheckpoint = (checkpoint: ReviewCheckpoint): void => {
    const repoPath = deps.getRepoPath()
    dom.reviewDrawerMeta.textContent = `${checkpoint.branch} · ${checkpoint.commit.slice(0, 7)}`
    dom.reviewDrawerBody.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'review-drawer-result',
      innerHTML: renderMarkdown(checkpoint.content),
    }))
    showReviewDrawer()
    const projectName = repoPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? repoPath
    const followUpAgent = (checkpoint.sessionAgent ?? 'claude') as AgentType
    askAi('', false, undefined, undefined, { role: 'assistant', content: checkpoint.content }, repoPath, followUpAgent, techReviewConversationKey(repoPath, checkpoint.branch), `${projectName} · ${checkpoint.branch}`, checkpoint.branch, checkpoint.commit, checkpoint.sessionId ?? undefined, checkpoint.sessionAgent ?? undefined, [])
  }

  // Re-open the last saved review for the selected branch. Findings are
  // checkpointed after each stage, so a crash or reload never loses them.
  const openSavedReview = async (): Promise<void> => {
    const repoPath = deps.getRepoPath()
    const branch = deps.getSelectedBranch()
    if (!repoPath || !branch) return
    const checkpoint = await loadReviewCheckpoint(repoPath, branch, localStorage.getItem(techReviewCheckpointKey(repoPath, branch)))
    if (!checkpoint) {
      const note = Object.assign(document.createElement('div'), { className: 'review-error', textContent: reviewT('noSavedReview') })
      dom.diffView.prepend(note)
      note.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    showCheckpoint(checkpoint)
  }

  // Every review of the project, whichever client ran it. They are all kept
  // now — this app saved them and could reach none but the newest.
  const showReviewHistory = async (): Promise<void> => {
    const repoPath = deps.getRepoPath()
    if (!repoPath) return
    const metas = await listReviewCheckpoints(repoPath)
    dom.reviewDrawerMeta.textContent = ''
    dom.reviewDrawerBody.replaceChildren(buildReviewHistory(metas, {
      onOpen: meta => {
        void loadReviewCheckpoint(repoPath, meta.base, null, meta.run_id).then(checkpoint => {
          if (checkpoint) showCheckpoint(checkpoint)
        })
      },
      onDelete: meta => {
        void deleteReviewCheckpoint(repoPath, meta.base, meta.run_id).then(showReviewHistory)
      },
    }))
    showReviewDrawer()
  }

  return { showReviewDrawer, hideReviewDrawer, openSavedReview, showReviewHistory }
}
