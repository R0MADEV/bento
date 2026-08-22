import { invoke } from '@tauri-apps/api/core'
import { reviewT } from './i18n'
import { renderReviewPrStateBadge, filterReviewPrs, type GhPr, type SidebarMode } from './reviewFormat'

export interface ReviewSidebarRefs {
  branchSearch: HTMLInputElement
  branchList: HTMLElement
  prList: HTMLElement
  branchesTab: HTMLButtonElement
  prsTab: HTMLButtonElement
  branchInput: HTMLInputElement
  branchDropdown: HTMLElement
}

export interface ReviewSidebarState {
  repoPath: () => string
  allBranches: () => string[]
  selectedBranch: () => string
  baseBranch: () => string
  setBaseBranch: (value: string) => void
  sidebarMode: () => SidebarMode
  setSidebarModeState: (mode: SidebarMode) => void
  openPrs: () => GhPr[]
  setOpenPrs: (prs: GhPr[]) => void
  currentPrNumber: () => number | null
  selectBranch: (branch: string) => void
  loadDiff: () => void
}

export interface ReviewSidebarLists {
  renderBranchList: () => void
  renderPrList: () => void
  loadPrList: () => Promise<void>
  setSidebarMode: (mode: SidebarMode) => void
  renderBaseDropdown: () => void
}

export function buildReviewSidebarLists(refs: ReviewSidebarRefs, state: ReviewSidebarState): ReviewSidebarLists {
  const { branchSearch, branchList, prList, branchesTab, prsTab, branchInput, branchDropdown } = refs

  // ── Sidebar: branches ─────────────────────────────────────────────────────
  const renderBranchList = (): void => {
    const q = branchSearch.value.toLowerCase()
    const branches = state.allBranches()
    const visible = q ? branches.filter(b => b.toLowerCase().includes(q)) : branches
    branchList.replaceChildren(...visible.slice(0, 50).map(b => {
      const item = Object.assign(document.createElement('div'), {
        className: `review-branch-item${b === state.selectedBranch() ? ' review-branch-item--active' : ''}`,
        textContent: b, title: b,
      })
      item.addEventListener('click', () => { state.selectBranch(b) })
      return item
    }))
  }

  // ── Sidebar: PR list ──────────────────────────────────────────────────────
  const renderPrList = (): void => {
    const openPrsList = state.openPrs()
    const visiblePrs = filterReviewPrs(openPrsList, branchSearch.value)
    if (!openPrsList.length) {
      prList.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-pr-list-empty', textContent: reviewT('noPrs') }))
      return
    }
    if (!visiblePrs.length) {
      prList.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-pr-list-empty', textContent: reviewT('noMatchingPrs') }))
      return
    }
    prList.replaceChildren(...visiblePrs.map(pr => {
      const item = document.createElement('div')
      item.className = `review-pr-item${state.currentPrNumber() === pr.number ? ' review-pr-item--active' : ''}`
      item.append(
        Object.assign(document.createElement('div'), { className: 'review-pr-item-title', textContent: `#${pr.number} ${pr.title}` }),
        Object.assign(document.createElement('div'), { className: 'review-pr-item-author', textContent: pr.author.login }),
      )
      const stateBadge = renderReviewPrStateBadge(pr.state, pr.mergedAt, 'review-pr-item-state')
      if (stateBadge) item.append(stateBadge)
      item.addEventListener('click', () => {
        const branches = state.allBranches()
        const branch = branches.find(b => b.endsWith('/' + pr.headRefName)) ?? ('origin/' + pr.headRefName)
        // Auto-set base branch from PR's base
        const prBase = branches.find(b => b.endsWith('/' + pr.baseRefName)) ?? ('origin/' + pr.baseRefName)
        state.setBaseBranch(prBase)
        branchInput.value = prBase
        state.selectBranch(branch)
      })
      return item
    }))
  }

  const loadPrList = async (): Promise<void> => {
    if (!state.repoPath()) return
    try {
      const prs = await invoke<GhPr[]>('gh_pr_list_open', { path: state.repoPath() })
      state.setOpenPrs(prs)
      if (state.sidebarMode() === 'prs') renderPrList()
    } catch { state.setOpenPrs([]) }
  }

  const setSidebarMode = (mode: SidebarMode): void => {
    state.setSidebarModeState(mode)
    branchesTab.classList.toggle('review-tab--active', mode === 'branches')
    prsTab.classList.toggle('review-tab--active', mode === 'prs')
    branchList.classList.toggle('hidden', mode === 'prs')
    prList.classList.toggle('hidden', mode === 'branches')
    if (mode === 'prs') { renderPrList(); if (!state.openPrs().length) loadPrList() }
  }

  // ── Base dropdown ─────────────────────────────────────────────────────────
  const renderBaseDropdown = (): void => {
    const q = branchInput.value.toLowerCase()
    const branches = state.allBranches()
    const matches = q ? branches.filter(b => b.toLowerCase().includes(q)) : branches
    branchDropdown.replaceChildren(...matches.slice(0, 20).map(b => {
      const item = Object.assign(document.createElement('div'), {
        className: `review-branch-option${b === state.baseBranch() ? ' review-branch-option--active' : ''}`, textContent: b,
      })
      item.addEventListener('mousedown', e => {
        e.preventDefault()
        state.setBaseBranch(b)
        branchInput.value = b
        branchDropdown.classList.add('hidden')
        if (state.selectedBranch()) state.loadDiff()
      })
      return item
    }))
    branchDropdown.classList.toggle('hidden', matches.length === 0)
  }

  branchSearch.addEventListener('input', () => {
    if (state.sidebarMode() === 'prs') { renderPrList(); return }
    renderBranchList()
  })
  branchesTab.addEventListener('click', () => setSidebarMode('branches'))
  prsTab.addEventListener('click', () => setSidebarMode('prs'))
  branchInput.addEventListener('focus', renderBaseDropdown)
  branchInput.addEventListener('input', renderBaseDropdown)
  branchInput.addEventListener('blur', () => setTimeout(() => branchDropdown.classList.add('hidden'), 150))
  branchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { branchDropdown.classList.add('hidden'); return }
    if (e.key === 'Enter') {
      branchDropdown.classList.add('hidden')
      const next = branchInput.value.trim().replace(':', '/')
      branchInput.value = next
      if (next && next !== state.baseBranch()) {
        state.setBaseBranch(next)
        if (state.selectedBranch()) state.loadDiff()
      }
    }
  })

  return { renderBranchList, renderPrList, loadPrList, setSidebarMode, renderBaseDropdown }
}
