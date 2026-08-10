import { AGENT_DOCK_EVENT, savedAgentDockEntries, type AgentDockEntry } from '../core/terminal/agentDockState'
import { appT } from '../core/i18n'

interface AgentStatusBarOptions {
  onOpenAgents: () => void
}

// CLI → display name mapping kept here so it doesn't couple to AgentsPanel.
const CLI_NAMES: Record<string, string> = {
  claude:    'Claude Code',
  codex:     'Codex',
  opencode:  'OpenCode',
}

const agentLabel = (entry: AgentDockEntry): string => CLI_NAMES[entry.cmd ?? ''] ?? entry.name

const statusText = (entry: AgentDockEntry): string => {
  if (entry.attention === 'bell') return appT('agentNeedsInput')
  if (entry.attention === 'blocked') return appT('agentWaiting')
  if (entry.status === 'working') return appT('agentWorking')
  if (entry.status === 'blocked') return appT('agentWaiting')
  return appT('agentIdle')
}

export function createAgentStatusBar({ onOpenAgents }: AgentStatusBarOptions): { element: HTMLElement; dispose: () => void } {
  const element = document.createElement('div')
  element.className = 'agent-status-bar hidden'
  element.setAttribute('role', 'status')

  let entries = savedAgentDockEntries()

  const render = (): void => {
    element.replaceChildren()
    element.classList.toggle('hidden', entries.length === 0)
    if (entries.length === 0) return

    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `agent-status-chip${entry.active ? ' active' : ''}`
      button.dataset.status = entry.attention ? 'blocked' : entry.status
      button.title = [entry.name, entry.cwd].filter(Boolean).join('\n')
      button.addEventListener('click', onOpenAgents)

      const dot = document.createElement('span')
      dot.className = 'agent-status-dot'
      const bar = document.createElement('span')
      bar.className = 'agent-status-meter'
      const label = Object.assign(document.createElement('span'), {
        className: 'agent-status-label',
        textContent: agentLabel(entry),
      })
      const state = Object.assign(document.createElement('span'), {
        className: 'agent-status-text',
        textContent: statusText(entry),
      })

      button.append(dot, bar, label, state)
      element.appendChild(button)
    }
  }

  const onDock = (event: Event): void => {
    entries = (event as CustomEvent<AgentDockEntry[]>).detail
    render()
  }
  window.addEventListener(AGENT_DOCK_EVENT, onDock)
  render()

  return {
    element,
    dispose: () => window.removeEventListener(AGENT_DOCK_EVENT, onDock),
  }
}
