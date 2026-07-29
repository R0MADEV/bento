import { previewRebase, type RebasePlanItem } from '../../core/git/rebaseWorkflow'
import { taskT } from './i18n'

export function buildRebasePlanPreview(items: RebasePlanItem[]): HTMLElement {
  const preview = previewRebase(items)
  const element = document.createElement('div')
  element.className = 'tasks-rebase-preview'
  element.dataset.testid = 'tasks-rebase-plan'
  element.append(
    Object.assign(document.createElement('strong'), { textContent: taskT('expectedResult', { count: preview.resultingCommits }) }),
    Object.assign(document.createElement('span'), { textContent: taskT('previewStats', {
      combined: preview.combinedCommits, dropped: preview.droppedCommits, edited: preview.editedCommits,
    }) }),
  )
  if (preview.warnings.length) element.appendChild(Object.assign(document.createElement('p'), {
    className: 'tasks-conflict-warning', textContent: preview.warnings.join(' '),
  }))
  const list = document.createElement('ol')
  preview.lines.forEach(line => list.appendChild(Object.assign(document.createElement('li'), { textContent: line })))
  element.appendChild(list)
  return element
}
