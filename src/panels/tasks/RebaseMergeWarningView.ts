import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import type { CommitEntry, RebaseStatus, RewritePreflight } from './gitTypes'
import { taskT } from './i18n'

export function buildRebaseMergeWarning(options: {
  worktree: Worktree
  baseBranch: string
  entries: CommitEntry[]
  merges: CommitEntry[]
  buildSubHead: (title: string, goBack: () => void) => HTMLElement
  onBack: () => void
  showDetail: (...nodes: HTMLElement[]) => void
  showRebaseEditor: (wt: Worktree, entries: CommitEntry[]) => void
  showRebasePaused: (wt: Worktree, status: RebaseStatus) => void
  recordOperation: (operation: string, status: 'success' | 'error', detail: string) => void
  onComplete: () => void
}): void {
  const { worktree: wt, baseBranch, entries, merges, buildSubHead, onBack, showDetail, showRebaseEditor, showRebasePaused, recordOperation, onComplete } = options
  const wrap = document.createElement('div')
  wrap.className = 'tasks-rebase-wrap'
  wrap.append(buildSubHead(taskT('branchHasMerges'), onBack))
  wrap.appendChild(Object.assign(document.createElement('p'), { className: 'tasks-rebase-hint tasks-conflict-warning', textContent: taskT('mergesWarning', { count: merges.length }) }))
  const list = document.createElement('div')
  list.className = 'tasks-log-list'
  merges.forEach(merge => {
    const row = document.createElement('div')
    row.className = 'tasks-log-item'
    row.append(
      Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: merge.short }),
      Object.assign(document.createElement('span'), { className: 'tasks-log-subject', textContent: merge.subject }),
    )
    list.appendChild(row)
  })
  wrap.appendChild(list)
  const footer = document.createElement('div')
  footer.className = 'tasks-rebase-footer'
  const status = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
  const flattenBtn = Object.assign(document.createElement('button'), { className: 'tasks-amend-btn', textContent: taskT('flatten') })
  const preserveBtn = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('preserveMerges') })
  flattenBtn.addEventListener('click', async () => {
    const ok = await askConfirm(taskT('flattenQuestion'), { title: taskT('flattenTitle'), kind: 'warning' })
    if (ok) showRebaseEditor(wt, entries)
  })
  preserveBtn.addEventListener('click', async () => {
    const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: baseBranch }).catch(() => null)
    if (preflight?.operation) { status.textContent = taskT('operationInProgress', { operation: preflight.operation }); return }
    const ok = await askConfirm(taskT('preserveQuestion', { count: merges.length, published: preflight?.publishedCommits ? ` ${preflight.publishedCommits} commit(s).` : '' }), { title: taskT('preserveTitle'), kind: 'warning' })
    if (!ok) return
    preserveBtn.disabled = true; flattenBtn.disabled = true; status.textContent = taskT('reorganizingMerges')
    try {
      const result = await invoke<string>('git_rebase_preserve_merges', { path: wt.path, base: baseBranch })
      recordOperation('rebase --rebase-merges', 'success', `origin/${baseBranch}`)
      if (result === 'paused') showRebasePaused(wt, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }))
      else { status.textContent = taskT('rebaseDone'); setTimeout(onComplete, 900) }
    } catch (error) {
      recordOperation('rebase --rebase-merges', 'error', String(error))
      status.textContent = String(error).slice(0, 150); preserveBtn.disabled = false; flattenBtn.disabled = false
    }
  })
  footer.append(status, flattenBtn, preserveBtn)
  wrap.appendChild(footer)
  showDetail(wrap)
}
