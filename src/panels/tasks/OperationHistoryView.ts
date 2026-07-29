import type { GitOperationEntry } from '../../core/git/rebaseWorkflow'

interface OperationHistoryOptions {
  branch: string
  repository: string
  entries: GitOperationEntry[]
  onBack: () => void
  onClear: () => void
}

export function buildOperationHistoryView(options: OperationHistoryOptions): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tasks-log-wrap'
  const head = document.createElement('div')
  head.className = 'db-detail-header'
  const back = Object.assign(document.createElement('button'), { className: 'db-back-btn', textContent: '←' })
  back.setAttribute('aria-label', 'Volver a los cambios')
  back.addEventListener('click', options.onBack)
  head.append(back, Object.assign(document.createElement('span'), { textContent: `Operaciones Git · ${options.branch}` }))
  wrap.append(head, Object.assign(document.createElement('p'), {
    className: 'tasks-rebase-hint',
    textContent: 'Registro local de las últimas operaciones iniciadas desde Bento. Los valores parecidos a credenciales se ocultan automáticamente.',
  }))

  const entries = options.entries.filter(entry => entry.repository === options.repository && entry.branch === options.branch)
  const list = document.createElement('div')
  list.className = 'tasks-backup-list'
  if (!entries.length) list.appendChild(Object.assign(document.createElement('div'), {
    className: 'db-detail-hint', textContent: 'Todavía no hay operaciones registradas para esta rama.',
  }))
  for (const entry of entries) {
    const item = document.createElement('div')
    item.className = `tasks-operation-item tasks-operation-item--${entry.status}`
    item.append(
      Object.assign(document.createElement('span'), { className: 'tasks-operation-status', textContent: entry.status === 'success' ? '✓' : '!' }),
      Object.assign(document.createElement('strong'), { textContent: entry.operation }),
      Object.assign(document.createElement('span'), { className: 'tasks-rebase-subject', textContent: entry.detail }),
      Object.assign(document.createElement('time'), { className: 'tasks-log-meta-inline', textContent: new Date(entry.timestamp).toLocaleString() }),
    )
    list.appendChild(item)
  }
  const clear = Object.assign(document.createElement('button'), { className: 'tasks-amend-btn', textContent: 'Limpiar registro', disabled: !entries.length })
  clear.addEventListener('click', options.onClear)
  wrap.append(list, clear)
  return wrap
}
