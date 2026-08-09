import { icon } from '../ui/icons'
import { appT } from '../core/i18n'
import { resumableAgents, recentProjects } from './homeData'

// Home shown in the center when there are no open sessions. v1 of the agent
// cockpit: a welcome + "new session" + the agents you can jump back into.
// Only agents that truly had a session (ran a CLI + captured a session id) are
// offered — a bare terminal has nothing to resume (see homeData).

const AGENTS_KEY = 'bento.agents.sessions'

function readResumableAgents() {
  try {
    return resumableAgents(JSON.parse(localStorage.getItem(AGENTS_KEY) ?? '[]'))
  } catch {
    return []
  }
}

const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export function createHomeView(opts: {
  onNewSession: () => void
  onResumeAgents: () => void
  onOpenProject: (cwd: string) => void
}): { element: HTMLElement; refresh: () => void } {
  const element = document.createElement('div')
  element.className = 'home-view'

  const refresh = (): void => {
    const card = document.createElement('div')
    card.className = 'home-card'

    const title = document.createElement('div')
    title.className = 'home-title'
    title.textContent = 'Bento'

    const subtitle = document.createElement('div')
    subtitle.className = 'home-subtitle'
    subtitle.textContent = appT('homeSubtitle')

    const newBtn = document.createElement('button')
    newBtn.type = 'button'
    newBtn.className = 'home-new'
    newBtn.innerHTML = `${icon('plus')}<span>${appT('newSession')}</span>`
    newBtn.addEventListener('click', opts.onNewSession)

    card.append(title, subtitle, newBtn)

    const recents = readResumableAgents()
    if (recents.length) {
      const heading = document.createElement('div')
      heading.className = 'home-section-title'
      heading.textContent = `${appT('homeResume')} (${recents.length})`
      card.appendChild(heading)

      // The panel's agents are saved and restored as one set, so a single action
      // brings them all back. The rows below are a preview of what returns.
      const group = document.createElement('button')
      group.type = 'button'
      group.className = 'home-resume-group'
      for (const agent of recents) {
        const row = document.createElement('span')
        row.className = 'home-recent-row'

        const name = document.createElement('span')
        name.className = 'home-recent-name'
        name.textContent = agent.name

        const path = document.createElement('span')
        path.className = 'home-recent-path'
        path.textContent = agent.cwd ? basename(agent.cwd) : ''
        path.title = agent.cwd ?? ''

        row.append(name, path)
        group.appendChild(row)
      }
      group.addEventListener('click', opts.onResumeAgents)
      card.appendChild(group)
    }

    const projects = recentProjects(recents)
    if (projects.length) {
      const heading = document.createElement('div')
      heading.className = 'home-section-title'
      heading.textContent = appT('homeProjects')
      card.appendChild(heading)

      const list = document.createElement('div')
      list.className = 'home-recents'
      for (const cwd of projects) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'home-recent'
        item.title = cwd

        const name = document.createElement('span')
        name.className = 'home-recent-name'
        name.textContent = basename(cwd)

        const path = document.createElement('span')
        path.className = 'home-recent-path'
        path.textContent = cwd

        item.append(name, path)
        item.addEventListener('click', () => opts.onOpenProject(cwd))
        list.appendChild(item)
      }
      card.appendChild(list)
    }

    element.replaceChildren(card)
  }

  refresh()
  return { element, refresh }
}
