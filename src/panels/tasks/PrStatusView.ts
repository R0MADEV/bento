import type { PrStatus } from '../../core/git/gitTypes'
import { taskT } from './i18n'

interface PrStatusViewOptions {
  pr: PrStatus
  baseBranch: string
  onBack: () => void
  onOpen: () => void
}

export function buildPrStatusView({ pr, baseBranch, onBack, onOpen }: PrStatusViewOptions): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tasks-log-wrap'
  const head = document.createElement('div')
  head.className = 'db-detail-header'
  const back = Object.assign(document.createElement('button'), { className: 'db-back-btn', textContent: '←' })
  back.setAttribute('aria-label', taskT('backChanges'))
  back.addEventListener('click', onBack)
  head.append(back, Object.assign(document.createElement('span'), {
    textContent: taskT('prNumberTitle', { number: pr.number, title: pr.title }),
  }))
  wrap.appendChild(head)

  const summary = document.createElement('div')
  summary.className = 'tasks-pr-summary'
  const review = pr.reviewDecision === 'APPROVED' ? taskT('approved') : pr.reviewDecision === 'CHANGES_REQUESTED'
    ? taskT('changesRequested') : pr.reviewDecision === 'REVIEW_REQUIRED' ? taskT('reviewPending') : taskT('noReview')
  summary.append(
    Object.assign(document.createElement('span'), { textContent: `${taskT('state')}: ${pr.isDraft ? taskT('draft') : pr.state.toLowerCase()}` }),
    Object.assign(document.createElement('span'), { textContent: `${taskT('merge')}: ${pr.mergeable === 'CONFLICTING' ? taskT('conflicts') : pr.mergeable === 'MERGEABLE' ? taskT('allowed') : taskT('calculating')}` }),
    Object.assign(document.createElement('span'), { textContent: `${taskT('review')}: ${review}` }),
    Object.assign(document.createElement('span'), { textContent: `${taskT('base')}: ${pr.baseRefName ?? baseBranch}` }),
  )
  const checks = document.createElement('div')
  checks.className = 'tasks-backup-list'
  for (const [index, check] of (pr.statusCheckRollup ?? []).entries()) {
    const state = check.conclusion ?? check.state ?? check.status ?? 'UNKNOWN'
    // Los veredictos vienen con el PR, en el mismo orden que los checks.
    const verdict = pr.checks.verdicts[index] ?? 'passed'
    const failed = verdict === 'failed'
    const pending = verdict === 'pending'
    const row = document.createElement('div')
    row.className = `tasks-operation-item tasks-operation-item--${failed ? 'error' : pending ? 'pending' : 'success'}`
    row.append(
      Object.assign(document.createElement('span'), { className: 'tasks-operation-status', textContent: failed ? '!' : pending ? '…' : '✓' }),
      Object.assign(document.createElement('strong'), { textContent: check.name ?? check.context ?? taskT('check') }),
      Object.assign(document.createElement('span'), { className: 'tasks-log-meta-inline', textContent: state.toLowerCase() }),
    )
    checks.appendChild(row)
  }
  if (!checks.childElementCount) checks.appendChild(Object.assign(document.createElement('div'), {
    className: 'db-detail-hint', textContent: taskT('noCi'),
  }))
  const open = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('openPr') })
  open.addEventListener('click', onOpen)
  wrap.append(summary, checks, open)
  return wrap
}
