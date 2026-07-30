import { invoke } from '@tauri-apps/api/core'
import { askAi } from '../../ui/askAi'
import { parseConflictFiles } from '../../core/git/conflictWorkflow'
import { taskT } from './i18n'

export function buildSyncErrorView(options: {
  mode: string
  errorText: string
  path: string
  showDetail: (...nodes: HTMLElement[]) => void
  iconButton: (name: string, title: string, onClick: () => void) => HTMLButtonElement
  status: (path: string) => Promise<{ raw: string }>
}): void {
  const { mode, errorText, path, showDetail, iconButton, status } = options
  const wrap = document.createElement('div')
  wrap.className = 'tasks-sync-error'
  const head = document.createElement('div')
  head.className = 'tasks-sync-error-head'
  head.append(
    Object.assign(document.createElement('span'), { className: 'tasks-sync-error-title', textContent: taskT('errorIn', { mode }) }),
    iconButton('chat', taskT('explainAi'), () => askAi(`/explica este error de git al hacer \`${mode}\`:\n\n\`\`\`\n${errorText.slice(-8000)}\n\`\`\``, true)),
  )
  wrap.append(head, Object.assign(document.createElement('pre'), { className: 'tasks-sync-error-body', textContent: errorText }))
  if (/conflict|CONFLICT/i.test(errorText)) {
    status(path).then(result => {
      const conflicts = parseConflictFiles(result.raw)
      if (!conflicts.length) return
      const conflictsEl = document.createElement('div')
      conflictsEl.className = 'tasks-conflicts'
      conflictsEl.appendChild(Object.assign(document.createElement('div'), { className: 'tasks-conflicts-title', textContent: taskT('conflictFiles', { count: conflicts.length }) }))
      conflicts.forEach(file => {
        const row = document.createElement('div')
        row.className = 'tasks-conflict-file'
        row.append(
          Object.assign(document.createElement('span'), { className: 'tasks-conflict-name', textContent: file }),
          iconButton('edit', taskT('openInEditor'), () => invoke('open_in_editor', { path: `${path}/${file}` }).catch(console.error)),
        )
        conflictsEl.appendChild(row)
      })
      wrap.appendChild(conflictsEl)
    }).catch(() => {})
  }
  showDetail(wrap)
}

export async function buildWorktreeTerminalView(options: {
  worktreePath: string
  branch: string
  buildSubHead: (title: string, goBack: () => void) => HTMLElement
  onBack: () => void
  showDetail: (...nodes: HTMLElement[]) => void
  setCleanup: (cleanup: () => void) => void
}): Promise<void> {
  const { worktreePath, branch, buildSubHead, onBack, showDetail, setCleanup } = options
  const { createTerminalPanel } = await import('../terminal/TerminalPanel')
  const wrap = document.createElement('div')
  wrap.className = 'tasks-term-wrap'
  const termBody = document.createElement('div')
  termBody.className = 'tasks-term-body'
  const term = createTerminalPanel('', worktreePath, onBack)
  termBody.appendChild(term.element)
  wrap.append(buildSubHead(`Terminal · ${branch}`, onBack), termBody)
  showDetail(wrap)
  requestAnimationFrame(() => term.fit())
  setCleanup(() => term.dispose())
}
