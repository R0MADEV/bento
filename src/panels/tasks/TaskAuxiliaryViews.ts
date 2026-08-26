import { invoke } from '@tauri-apps/api/core'
import { askAi } from '../../ui/askAi'
import { taskT } from './i18n'

export function buildSyncErrorView(options: {
  mode: string
  errorText: string
  path: string
  showDetail: (...nodes: HTMLElement[]) => void
  iconButton: (name: string, title: string, onClick: () => void) => HTMLButtonElement
}): void {
  const { mode, errorText, path, showDetail, iconButton } = options
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
    // Qué códigos del porcelain son un conflicto lo dice `bento_review::status`.
    invoke<string[]>('git_conflicted_files', { path }).then(conflicts => {
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
