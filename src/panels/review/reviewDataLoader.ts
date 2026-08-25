import { invoke } from '@tauri-apps/api/core'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { parseDiffFiles } from '../../core/git/diffStats'
import { diffGit } from '../diff/diffGitClient'
import { reviewT } from './i18n'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import type { ReviewChangeFile, GhComment, GhPr, SidebarMode, FileTypeFilter } from './reviewFormat'
import { renderReviewPrStateBadge, describeReviewNoBranchChanges, getFileState, relativeTime } from './reviewFormat'
import { prCheckReport } from './prChecks'

export type StatusRollupEntry = { name?: string; workflowName?: string; conclusion?: string | null; state?: string; context?: string; targetUrl?: string }

export interface ReviewDataLoaderDom {
  filterBar: HTMLElement
  diffSearchInput: HTMLInputElement
  diffView: HTMLElement
  prMetaEl: HTMLElement
  prBodyEl: HTMLElement
  discussionEl: HTMLElement
  commentBar: HTMLElement
  branchInput: HTMLInputElement
  viewedCounterEl: HTMLElement
  commentNavWrap: HTMLElement
  commentInput: HTMLTextAreaElement
  approveBtn: HTMLButtonElement
  requestChangesBtn: HTMLButtonElement
}

export interface ReviewDataLoaderState {
  getRepoPath: () => string
  setRepoPath: (v: string) => void
  getBaseBranch: () => string
  setBaseBranch: (v: string) => void
  getSelectedBranch: () => string
  setSelectedBranch: (v: string) => void
  getActiveLocalBranch: () => string
  setActiveLocalBranch: (v: string) => void
  setAllBranches: (v: string[]) => void
  getCurrentPrNumber: () => number | null
  setCurrentPrNumber: (v: number | null) => void
  getExistingComments: () => GhComment[]
  setExistingComments: (v: GhComment[]) => void
  getLoadingBranch: () => string
  setLoadingBranch: (v: string) => void
  getSidebarMode: () => SidebarMode
  setOpenPrs: (v: GhPr[]) => void
  setFileTypeFilter: (v: FileTypeFilter) => void
  getTotalFiles: () => number
  setTotalFiles: (v: number) => void
  setLastFiles: (v: ReviewChangeFile[]) => void
  setLastStatusRollup: (v: StatusRollupEntry[]) => void
  setResolvedComments: (v: Set<number>) => void
  getResolvedComments: () => Set<number>
  nextDiscSeq: () => number
  getDiscSeq: () => number
  nextPrInfoSeq: () => number
  getPrInfoSeq: () => number
  setCurrentPrTitle: (v: string) => void
  setCurrentPrBody: (v: string) => void
  getCurrentPrState: () => string | null
  setCurrentPrState: (v: string | null) => void
  getViewedFiles: () => Set<string>
  renderBranchList: () => void
  renderPrList: () => void
  loadPrList: () => Promise<void>
  renderFiles: () => void
  injectExistingComments: () => void
  updateViewedCounter: () => void
  showCommentStatus: (text: string, isError?: boolean) => void
  showCiPopover: (anchor: HTMLElement) => void
}

export interface ReviewDataLoader {
  loadDiff: () => Promise<void>
  loadPrInfo: () => Promise<void>
  loadExistingComments: () => Promise<void>
  selectBranch: (branch: string) => Promise<void>
  submitReview: (event: 'APPROVE' | 'REQUEST_CHANGES') => Promise<void>
  loadBranches: () => Promise<void>
  pickRepo: () => Promise<void>
  prIdentifier: () => string
}

const REPO_KEY = 'bento.review.repo'
const BASE_KEY = 'bento.review.base'

export function buildReviewDataLoader(dom: ReviewDataLoaderDom, state: ReviewDataLoaderState): ReviewDataLoader {
  const { filterBar, diffSearchInput, diffView, prMetaEl, prBodyEl, discussionEl, commentBar, branchInput, viewedCounterEl, commentNavWrap, commentInput, approveBtn, requestChangesBtn } = dom

  const ghBranch = (b: string): string => b.replace(/^[^/]+\//, '')

  const loadExistingComments = async (): Promise<void> => {
    if (state.getCurrentPrNumber() === null) { state.setExistingComments([]); return }
    try {
      const raw = await invoke<GhComment[]>('gh_pr_list_comments', { path: state.getRepoPath(), prNumber: state.getCurrentPrNumber() })
      state.setExistingComments(raw.filter(c => c.line != null))
      state.setResolvedComments(state.getResolvedComments())
    } catch { state.setExistingComments([]) }
  }

  // ── Load diff ─────────────────────────────────────────────────────────────
  const loadDiff = async (): Promise<void> => {
    filterBar.classList.add('hidden')
    diffSearchInput.classList.add('hidden')
    state.setFileTypeFilter('all')
    diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }))
    try {
      const repoPath = state.getRepoPath()
      const baseBranch = state.getBaseBranch()
      const selectedBranch = state.getSelectedBranch()
      let raw = selectedBranch === state.getActiveLocalBranch()
        ? await diffGit.reviewWorktreeDiff(repoPath, baseBranch)
        : await invoke<string>('git_ref_diff', { path: repoPath, base: baseBranch, target: selectedBranch })
      if (!raw.trim() && state.getCurrentPrState() === 'MERGED' && state.getCurrentPrNumber() !== null) {
        const prDiff = await invoke<string>('gh_pr_diff_number', { path: repoPath, prNumber: state.getCurrentPrNumber() }).catch(() => '')
        if (prDiff.trim()) raw = prDiff
      }
      if (!raw.trim()) {
        state.setTotalFiles(0); state.setLastFiles([]); state.updateViewedCounter()
        diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: describeReviewNoBranchChanges(state.getCurrentPrState(), baseBranch) }))
        return
      }
      const lastFiles = parseDiffFiles(raw).map(f => ({ ...f, state: getFileState(f.chunk) }))
      state.setLastFiles(lastFiles)
      state.setTotalFiles(lastFiles.length)
      state.updateViewedCounter()
      state.renderFiles()
      diffSearchInput.classList.remove('hidden')
    } catch (e) {
      diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-error', textContent: String(e) }))
    }
  }

  // ── Load PR info ──────────────────────────────────────────────────────────
  const loadPrInfo = async (): Promise<void> => {
    const myPrSeq = state.nextPrInfoSeq()
    state.setCurrentPrNumber(null); state.setExistingComments([]); state.setCurrentPrTitle(''); state.setCurrentPrBody('')
    prMetaEl.replaceChildren(); prBodyEl.innerHTML = ''; prBodyEl.classList.add('hidden')
    discussionEl.replaceChildren(); discussionEl.classList.add('hidden')
    commentBar.classList.add('hidden')
    state.setLastStatusRollup([])
    try {
      const repoPath = state.getRepoPath()
      const pr = await invoke<{
        number: number; title: string; url: string; body: string; state?: string; mergedAt?: string | null
        statusCheckRollup: StatusRollupEntry[]
        reviewDecision: string | null
      } | null>('gh_pr_view_branch', { path: repoPath, branch: ghBranch(state.getSelectedBranch()) })
      if (state.getPrInfoSeq() !== myPrSeq) return
      if (pr) {
        state.setCurrentPrNumber(pr.number)
        state.setCurrentPrTitle(pr.title)
        state.setCurrentPrBody(pr.body ?? '')
        state.setCurrentPrState(pr.state ?? null)
        const statusRollup = pr.statusCheckRollup ?? []
        state.setLastStatusRollup(statusRollup)
        const link = Object.assign(document.createElement('a'), { className: 'review-pr-link', textContent: reviewT('prTitle', { number: pr.number, title: pr.title }), href: '#' })
        link.addEventListener('click', e => { e.preventDefault(); openUrl(pr.url).catch(() => {}) })
        prMetaEl.append(link)

        const stateBadge = renderReviewPrStateBadge(pr.state, pr.mergedAt, 'review-pr-state')
        if (stateBadge) prMetaEl.append(stateBadge)

        // Cómo van los checks lo decide `bento_review::pr`; aquí solo se elige
        // qué se pinta con ese recuento.
        const report = await prCheckReport(statusRollup)
        const ci = report.total === 0 ? 'none'
          : report.failed ? 'failure'
            : report.pending ? 'pending' : 'success'
        if (ci !== 'none') {
          const ciEl = Object.assign(document.createElement('span'), {
            className: `review-ci review-ci--${ci}`,
            textContent: reviewT(ci === 'success' ? 'ciPassing' : ci === 'failure' ? 'ciFailing' : 'ciRunning'),
          })
          ciEl.style.cursor = 'pointer'
          ciEl.addEventListener('click', e => { e.stopPropagation(); state.showCiPopover(ciEl) })
          prMetaEl.append(ciEl)
        }

        const decMap: Record<string, { text: string; cls: string }> = {
          APPROVED: { text: '✓ Approved', cls: 'review-decision--approved' },
          CHANGES_REQUESTED: { text: '✗ Changes requested', cls: 'review-decision--changes' },
          REVIEW_REQUIRED: { text: '? Review required', cls: 'review-decision--required' },
        }
        const dec = pr.reviewDecision ? decMap[pr.reviewDecision] : null
        if (dec) prMetaEl.append(Object.assign(document.createElement('span'), { className: `review-decision ${dec.cls}`, textContent: dec.text }))

        if (pr.body?.trim()) {
          prBodyEl.innerHTML = `<span class="review-pr-body-label">Description</span>${renderMarkdown(pr.body)}`
          prBodyEl.classList.remove('hidden')
        }
        commentBar.classList.remove('hidden')
        await loadExistingComments()

        // ── Discussion thread — loaded separately so a failure doesn't break PR info ──
        const myDiscSeq = state.nextDiscSeq()
        invoke<{ comments: any[]; reviews: any[] }>('gh_pr_list_discussion', { path: repoPath, prNumber: pr.number })
          .then(disc => {
            if (state.getDiscSeq() !== myDiscSeq) return // newer loadPrInfo started
            type DiscItem = { author: string; body: string; time: string; decision?: { text: string; cls: string } }
            const discItems: DiscItem[] = [
              ...(disc.reviews ?? [])
                .filter((r: any) => r.body?.trim() && r.state !== 'PENDING')
                .map((r: any) => ({ author: r.user?.login ?? '?', body: r.body, time: r.submitted_at ?? '', decision: decMap[r.state] })),
              ...(disc.comments ?? [])
                .filter((c: any) => c.body?.trim())
                .map((c: any) => ({ author: c.user?.login ?? '?', body: c.body, time: c.created_at ?? '' })),
            ].sort((a, b) => a.time.localeCompare(b.time))
            if (discItems.length === 0) return
            const hdr = Object.assign(document.createElement('div'), {
              className: 'review-discussion-header',
              textContent: reviewT('discussionCount', { count: discItems.length }),
            })
            discussionEl.replaceChildren(hdr, ...discItems.map(item => {
              const msg = document.createElement('div')
              msg.className = 'review-discussion-item'
              const meta = document.createElement('div')
              meta.className = 'review-discussion-meta'
              meta.append(Object.assign(document.createElement('span'), { className: 'review-comment-author', textContent: item.author }))
              if (item.decision) meta.append(Object.assign(document.createElement('span'), { className: `review-decision ${item.decision.cls} review-decision--sm`, textContent: item.decision.text }))
              if (item.time) meta.append(Object.assign(document.createElement('span'), { className: 'review-comment-time', textContent: relativeTime(item.time) }))
              const bodyDiv = Object.assign(document.createElement('div'), { className: 'review-discussion-body' })
              bodyDiv.innerHTML = renderMarkdown(item.body)
              msg.append(meta, bodyDiv)
              return msg
            }))
            discussionEl.classList.remove('hidden')
          })
          .catch(() => { /* discussion unavailable, PR info unaffected */ })

        if (state.getSidebarMode() === 'prs') state.renderPrList()
      }
    } catch { state.setCurrentPrState(null) }
  }

  const prIdentifier = (): string => {
    const currentPrNumber = state.getCurrentPrNumber()
    return currentPrNumber !== null ? String(currentPrNumber) : ghBranch(state.getSelectedBranch())
  }

  // ── Select branch ─────────────────────────────────────────────────────────
  const selectBranch = async (branch: string): Promise<void> => {
    state.setSelectedBranch(branch); state.setLoadingBranch(branch)
    state.renderBranchList()
    if (state.getSidebarMode() === 'prs') state.renderPrList()
    await Promise.all([loadDiff(), loadPrInfo()])
    if (state.getLoadingBranch() === branch) state.injectExistingComments()
  }

  // ── Submit PR review (with summary confirm) ───────────────────────────────
  const submitReview = async (event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> => {
    const currentPrNumber = state.getCurrentPrNumber()
    if (currentPrNumber === null) return
    const body = commentInput.value.trim()
    const viewed = state.getViewedFiles().size
    const key = event === 'APPROVE' ? 'approveConfirm' : 'requestChangesConfirm'
    const msg = reviewT(key, { number: currentPrNumber, viewed, total: state.getTotalFiles(), comments: state.getExistingComments().length })
    if (!confirm(msg)) return
    approveBtn.disabled = true; requestChangesBtn.disabled = true
    try {
      await invoke<string>('gh_pr_submit_review', { path: state.getRepoPath(), prNumber: currentPrNumber, event, body })
      commentInput.value = ''
      state.showCommentStatus(reviewT('reviewSubmitted'))
      await loadPrInfo()
      state.injectExistingComments()
    } catch (e) {
      state.showCommentStatus(String(e), true)
    } finally { approveBtn.disabled = false; requestChangesBtn.disabled = false }
  }

  // ── Load branches ─────────────────────────────────────────────────────────
  const loadBranches = async (): Promise<void> => {
    const repoPath = state.getRepoPath()
    if (!repoPath) return
    const [defaultBranch, branches, currentBranch] = await Promise.all([
      diffGit.defaultBranch(repoPath),
      diffGit.reviewBranches(repoPath),
      diffGit.currentBranch(repoPath),
    ])
    const allBranches = currentBranch
      ? [currentBranch, ...branches.filter(branch => branch !== currentBranch)]
      : branches
    state.setAllBranches(allBranches)
    state.setActiveLocalBranch(currentBranch)
    if (!state.getBaseBranch()) {
      const originDefault = `origin/${defaultBranch}`
      const baseBranch = allBranches.includes(originDefault) ? originDefault : defaultBranch
      state.setBaseBranch(baseBranch)
      branchInput.value = baseBranch
      localStorage.setItem(BASE_KEY, baseBranch)
    }
    state.renderBranchList()
    state.loadPrList()
    if (!state.getSelectedBranch() && currentBranch && currentBranch !== defaultBranch) {
      void selectBranch(currentBranch)
    }
  }

  const pickRepo = async (): Promise<void> => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    state.setRepoPath(picked); state.setBaseBranch(''); branchInput.value = ''
    state.setSelectedBranch(''); state.setActiveLocalBranch(''); state.setExistingComments([]); state.setTotalFiles(0)
    state.setFileTypeFilter('all'); state.setOpenPrs([]); state.setLastFiles([]); state.setLastStatusRollup([])
    localStorage.setItem(REPO_KEY, picked)
    diffView.replaceChildren(); filterBar.classList.add('hidden')
    diffSearchInput.classList.add('hidden'); prBodyEl.classList.add('hidden')
    commentBar.classList.add('hidden'); viewedCounterEl.classList.add('hidden')
    commentNavWrap.classList.add('hidden')
    await loadBranches()
  }

  return { loadDiff, loadPrInfo, loadExistingComments, selectBranch, submitReview, loadBranches, pickRepo, prIdentifier }
}
