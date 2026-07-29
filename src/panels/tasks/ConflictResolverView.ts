import { invoke } from '@tauri-apps/api/core'
import { parseConflictHunks, reconstructFromHunks, type ConflictSegment } from '../../core/git/conflictWorkflow'
import { taskT } from './i18n'

interface ConflictResolverOptions {
  path: string
  file: string
  onBack: () => void
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return error instanceof Error ? error.message : String(error)
}

export function buildConflictResolverView({ path, file, onBack }: ConflictResolverOptions): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tasks-conflict-resolver'
  wrap.dataset.testid = 'tasks-conflict-resolver'
  const head = document.createElement('div')
  head.className = 'db-detail-header'
  const back = Object.assign(document.createElement('button'), { className: 'db-back-btn', textContent: '←' })
  back.setAttribute('aria-label', taskT('backChanges'))
  back.addEventListener('click', onBack)
  head.append(back, Object.assign(document.createElement('span'), { textContent: `${taskT('conflictTitle')}: ${file.split('/').pop()}` }))
  wrap.appendChild(head)

  const body = document.createElement('div')
  body.className = 'tasks-conflict-resolver-body'
  const footer = document.createElement('div')
  footer.className = 'tasks-rebase-paused-actions'
  const progress = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
  progress.dataset.testid = 'tasks-conflict-status'
  const save = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('saveResolved'), disabled: true })
  save.dataset.testid = 'tasks-conflict-save'
  footer.append(progress, save)
  wrap.append(body, footer)

  let segments: ConflictSegment[] = []
  const refresh = (): void => {
    const hunks = segments.filter(segment => segment.type === 'hunk') as Extract<ConflictSegment, { type: 'hunk' }>[]
    const resolved = hunks.filter(hunk => hunk.choice !== null).length
    progress.textContent = hunks.length ? taskT('resolvedCount', { resolved, total: hunks.length }) : taskT('noConflicts')
    save.disabled = resolved < hunks.length
  }
  const render = (): void => {
    body.replaceChildren()
    segments.forEach((segment, segmentIndex) => {
      if (segment.type === 'context') {
        body.appendChild(Object.assign(document.createElement('pre'), { className: 'tasks-conflict-ctx', textContent: segment.lines.join('\n') }))
        return
      }
      const hunk = segment
      const hunkElement = document.createElement('div')
      hunkElement.className = `tasks-conflict-hunk${hunk.choice ? ' tasks-conflict-hunk-done' : ''}`
      const block = (label: string, lines: string[], side: 'ours' | 'theirs'): HTMLElement => {
        const element = document.createElement('div')
        element.className = `tasks-conflict-block tasks-conflict-${side}${hunk.choice === side ? ' tasks-conflict-chosen' : ''}`
        const blockHead = document.createElement('div')
        blockHead.className = 'tasks-conflict-block-head'
        const choose = Object.assign(document.createElement('button'), {
          className: 'tasks-conflict-pick-btn', textContent: hunk.choice === side ? taskT('chosen') : taskT('choose'),
        })
        choose.addEventListener('click', () => {
          segments[segmentIndex] = { ...hunk, choice: hunk.choice === side ? null : side }
          render(); refresh()
        })
        blockHead.append(Object.assign(document.createElement('span'), { className: 'tasks-conflict-block-label', textContent: label }), choose)
        element.append(blockHead, Object.assign(document.createElement('pre'), { className: 'tasks-conflict-code', textContent: lines.join('\n') }))
        return element
      }
      const both = Object.assign(document.createElement('button'), {
        className: 'tasks-conflict-btn tasks-conflict-both-btn', textContent: hunk.choice === 'both' ? taskT('bothChosen') : taskT('keepBoth'),
      })
      both.addEventListener('click', () => {
        segments[segmentIndex] = { ...hunk, choice: hunk.choice === 'both' ? null : 'both' }
        render(); refresh()
      })
      hunkElement.append(
        block(taskT('currentResult'), hunk.ours, 'ours'),
        block(taskT('appliedChange', { label: hunk.label }), hunk.theirs, 'theirs'),
        both,
      )
      body.appendChild(hunkElement)
    })
  }
  save.addEventListener('click', async () => {
    save.disabled = true
    try {
      await invoke('git_write_file', { path, file, content: reconstructFromHunks(segments) })
      await invoke('git_add_files', { path, files: [file] })
      onBack()
    } catch (error) { progress.textContent = errorMessage(error).slice(0, 240); save.disabled = false }
  })
  body.textContent = taskT('loading')
  invoke<string>('git_read_file', { path, file }).then(content => {
    segments = parseConflictHunks(content); render(); refresh()
  }).catch(error => { body.textContent = errorMessage(error) })
  return wrap
}
