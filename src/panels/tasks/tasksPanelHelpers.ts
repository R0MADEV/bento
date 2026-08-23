import { icon } from '../../ui/icons'
import { taskT } from './i18n'
import type { TasksPanelCtx } from './tasksPanelContext'

export function note(text: string, cls = 'tasks-note'): HTMLElement {
  return Object.assign(document.createElement('div'), { className: cls, textContent: text })
}

export function iconBtn(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'docker-action'
  b.title = title
  b.innerHTML = icon(name)
  b.addEventListener('click', e => { e.stopPropagation(); onClick() })
  return b
}

export function buildSubHead(title: string, goBack: () => void, ...extra: HTMLElement[]): HTMLElement {
  const head = document.createElement('div')
  head.className = 'tasks-sub-head'
  head.append(
    iconBtn('arrow-left', taskT('back'), goBack),
    Object.assign(document.createElement('span'), { className: 'tasks-sub-title', textContent: title }),
    ...extra,
  )
  return head
}

export function showDetail(ctx: TasksPanelCtx, ...nodes: HTMLElement[]): void {
  ctx.detailPane.replaceChildren(...nodes)
}
