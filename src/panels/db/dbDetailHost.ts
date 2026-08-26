import { t as i18nT } from '../../i18n'
import { icon } from '../../ui/helpers/icons'
import { askAi } from '../../ui/askAi'

// The right-hand pane: every view renders into it, and its header can hand the
// current contents (or the user's selection) to the AI chat.
export interface DbDetailHost {
  showDetail: (...nodes: HTMLElement[]) => void
  detailHead: (path: string, count: string) => HTMLElement
}

export function createDetailHost(detail: HTMLElement): DbDetailHost {
  const showDetail = (...nodes: HTMLElement[]): void => { detail.replaceChildren(...nodes) }

  const detailHead = (path: string, count: string): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = 'db-detail-head'
    const p = document.createElement('span')
    p.className = 'db-detail-path'
    p.textContent = path
    const c = document.createElement('span')
    c.className = 'db-detail-count'
    c.textContent = count
    // Send to the AI chat: the selection or, if there's none, the current view (table/docs).
    const askBtn = document.createElement('button')
    askBtn.className = 'db-action'
    askBtn.title = i18nT('common.sendToAiChat')
    askBtn.innerHTML = icon('chat')
    askBtn.addEventListener('click', () => {
      const selection = window.getSelection()?.toString().trim()
      const content = (selection || detail.textContent || '').slice(-12000)
      if (content.trim()) askAi(`Contexto — datos de BD (${path}):\n\n\`\`\`\n${content}\n\`\`\`\n\n`)
    })
    bar.append(p, c, askBtn)
    return bar
  }

  return { showDetail, detailHead }
}
