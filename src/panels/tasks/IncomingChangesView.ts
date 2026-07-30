import { taskT } from './i18n'
import { renderPatchHtml } from './TaskCodeView'

export function buildIncomingChangesView(raw: string, selectedFiles: string[] | undefined, note: (text: string, cls?: string) => HTMLElement): HTMLElement {
  const section = document.createElement('section')
  section.className = 'tasks-fixup-incoming'
  const selected = selectedFiles ? new Set(selectedFiles) : null
  const chunks = raw.split(/(?=^diff --git )/m).filter(Boolean).filter(chunk => {
    if (!selected) return true
    const firstLine = chunk.split('\n')[0] ?? ''
    const fileName = firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
    return selected.has(fileName)
  })
  section.appendChild(Object.assign(document.createElement('h3'), { className: 'tasks-fixup-incoming-title', textContent: taskT('incomingChanges', { count: chunks.length }) }))
  chunks.forEach(chunk => {
    const firstLine = chunk.split('\n')[0] ?? ''
    const fileName = firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
    const lines = chunk.split('\n')
    const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length
    const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length
    const details = document.createElement('details'); details.className = 'tasks-diff-file'; details.open = chunks.length === 1
    const summary = document.createElement('summary'); summary.className = 'tasks-diff-summary'
    const stats = Object.assign(document.createElement('span'), { className: 'tasks-diff-stats' })
    if (additions) stats.innerHTML += `<span class="tasks-diff-add">+${additions}</span>`
    if (deletions) stats.innerHTML += `<span class="tasks-diff-del">-${deletions}</span>`
    summary.append(Object.assign(document.createElement('span'), { className: 'tasks-diff-name', textContent: fileName }), stats)
    details.append(summary, Object.assign(document.createElement('pre'), { className: 'tasks-diff-body', innerHTML: renderPatchHtml(chunk) }))
    section.appendChild(details)
  })
  if (!chunks.length) section.appendChild(note(taskT('noSelectedTextDiff'), 'db-detail-hint'))
  return section
}
