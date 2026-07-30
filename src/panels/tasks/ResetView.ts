import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { taskT } from './i18n'

type ResetMode = 'mixed' | 'soft' | 'hard'

export function buildResetView(options: {
  worktree: Worktree
  baseBranch: string
  buildSubHead: (title: string, goBack: () => void) => HTMLElement
  onBack: () => void
  onComplete: () => void
  recordOperation: (operation: string, status: 'success' | 'error', detail: string) => void
}): HTMLElement {
  const { worktree, baseBranch, buildSubHead, onBack, onComplete, recordOperation } = options
  const wrap = document.createElement('div')
  wrap.className = 'tasks-reset-wrap'
  wrap.append(buildSubHead(taskT('resetTitle', { branch: worktree.branch ?? '' }), onBack))

  wrap.appendChild(Object.assign(document.createElement('p'), {
    className: 'tasks-rebase-hint',
    textContent: taskT('resetHint'),
  }))

  const form = document.createElement('div')
  form.className = 'tasks-reset-form'
  form.append(
    Object.assign(document.createElement('label'), { className: 'tasks-reset-label', textContent: taskT('resetTo') }),
  )
  const targetInput = Object.assign(document.createElement('input'), {
    className: 'tasks-name-input',
    type: 'text',
    value: `origin/${baseBranch}`,
  })
  form.appendChild(targetInput)

  const modeLabel = Object.assign(document.createElement('label'), { className: 'tasks-reset-label', textContent: taskT('mode') })
  const modeGroup = document.createElement('div')
  modeGroup.className = 'tasks-reset-modes'
  const modes: { value: ResetMode; label: string; desc: string }[] = [
    { value: 'mixed', label: taskT('mixedLabel'), desc: taskT('mixedDesc') },
    { value: 'soft', label: 'Soft', desc: taskT('softDesc') },
    { value: 'hard', label: 'Hard ⚠', desc: taskT('hardDesc') },
  ]
  let selectedMode: ResetMode = 'mixed'
  const statusEl = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
  const resetBtn = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('reset') })

  modes.forEach(mode => {
    const row = document.createElement('label')
    row.className = 'tasks-reset-mode-row'
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'reset-mode', value: mode.value })
    radio.checked = mode.value === 'mixed'
    radio.addEventListener('change', () => {
      selectedMode = mode.value
      resetBtn.classList.toggle('tasks-reset-danger', mode.value === 'hard')
    })
    row.append(
      radio,
      Object.assign(document.createElement('span'), { className: 'tasks-reset-mode-name', textContent: mode.label }),
      Object.assign(document.createElement('span'), { className: 'tasks-reset-mode-desc', textContent: mode.desc }),
    )
    modeGroup.appendChild(row)
  })
  form.append(modeLabel, modeGroup)
  wrap.appendChild(form)

  resetBtn.addEventListener('click', async () => {
    const target = targetInput.value.trim()
    if (!target) return
    if (selectedMode === 'hard') {
      const ok = await askConfirm(taskT('hardResetQuestion', { target }), { title: taskT('hardResetTitle'), kind: 'warning' })
      if (!ok) return
    }
    resetBtn.disabled = true
    statusEl.textContent = taskT('running')
    try {
      await invoke('git_reset', { path: worktree.path, target, mode: selectedMode })
      recordOperation(`reset --${selectedMode}`, 'success', target)
      statusEl.textContent = taskT('resetDone', { target })
      setTimeout(onComplete, 900)
    } catch (error) {
      recordOperation(`reset --${selectedMode}`, 'error', String(error))
      statusEl.textContent = String(error).slice(0, 160)
      resetBtn.disabled = false
    }
  })

  const footer = document.createElement('div')
  footer.className = 'tasks-rebase-paused-actions'
  footer.append(statusEl, resetBtn)
  wrap.appendChild(footer)
  return wrap
}
