import type { JiraIssue } from '../../core/jira/issues'

// Las tarjetas del tablero y los avatares de la barra de filtro. Solo dibujan:
// qué pasa al pulsarlas lo decide quien las crea.

export interface JiraCardDeps {
  openIssue: (issue: JiraIssue) => void
}

export function buildJiraCards(deps: JiraCardDeps): {
  makeCard: (issue: JiraIssue, colName: string) => HTMLElement
  makeAvatarBtn: (name: string, id: string, avatarUrl: string, active: boolean, onClick: () => void) => HTMLButtonElement
  makeAvatarInitials: (name: string) => HTMLElement
} {
  const makeCard = (issue: JiraIssue, colName: string): HTMLElement => {
    const card = document.createElement('div')
    card.className = 'jira-board-card'
    card.draggable = true
    card.dataset.issueKey = issue.key
    const keyEl = document.createElement('span')
    keyEl.className = 'jira-key'
    keyEl.textContent = issue.key
    const summary = document.createElement('p')
    summary.className = 'jira-board-card-summary'
    summary.textContent = issue.summary
    if (issue.assignee) {
      const assignee = document.createElement('span')
      assignee.className = 'jira-board-card-assignee'
      assignee.textContent = issue.assignee
      card.append(keyEl, summary, assignee)
    } else {
      card.append(keyEl, summary)
    }
    card.addEventListener('click', () => deps.openIssue(issue))
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging')
      e.dataTransfer?.setData('text/plain', issue.key)
      e.dataTransfer?.setData('jira-from-col', colName)
    })
    card.addEventListener('dragend', () => card.classList.remove('dragging'))
    return card
  }

  const makeAvatarBtn = (name: string, _id: string, avatarUrl: string, active: boolean, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.className = active ? 'jira-avatar-btn active' : 'jira-avatar-btn'
    btn.title = name
    if (avatarUrl) {
      const img = document.createElement('img')
      img.src = avatarUrl
      img.className = 'jira-avatar-img'
      img.alt = name
      img.onerror = () => img.replaceWith(makeAvatarInitials(name))
      btn.append(img)
    } else {
      btn.append(makeAvatarInitials(name))
    }
    btn.addEventListener('click', onClick)
    return btn
  }

  const makeAvatarInitials = (name: string): HTMLElement => {
    const el = document.createElement('span')
    el.className = 'jira-avatar-initials'
    const parts = name.trim().split(' ')
    el.textContent = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase()
    // Consistent color from name hash
    const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0) % 360
    el.style.background = `hsl(${hue} 55% 40%)`
    return el
  }
  return { makeCard, makeAvatarBtn, makeAvatarInitials }
}
