import { AGENT_DOCK_EVENT, savedAgentDockEntries, type AgentDockEntry } from '../core/terminal/agentDockState'
import { appT } from '../core/i18n'
import { invoke } from '@tauri-apps/api/core'

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

export const formatMemoryUsage = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export function createAgentStatusBar({ onOpenAgents }: AgentStatusBarOptions): { element: HTMLElement; dispose: () => void } {
  const element = document.createElement('div')
  element.className = 'agent-status-bar'
  element.setAttribute('role', 'status')

  let entries = savedAgentDockEntries()

  const agents = document.createElement('div')
  agents.className = 'agent-status-list'

  const memory = document.createElement('div')
  memory.className = 'app-memory-status'
  memory.setAttribute('aria-label', appT('ramUsage'))
  memory.title = appT('ramUsage')
  memory.innerHTML = '<span class="app-memory-label">RAM</span><span class="app-memory-value">—</span>'
  const memoryValue = memory.querySelector<HTMLElement>('.app-memory-value')!

  const render = (): void => {
    agents.replaceChildren()

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
      agents.appendChild(button)
    }
  }

  let memoryRequestActive = false
  const refreshMemory = async (): Promise<void> => {
    if (memoryRequestActive || document.hidden) return
    memoryRequestActive = true
    try {
      const bytes = await invoke<number>('app_memory_usage')
      memoryValue.textContent = formatMemoryUsage(bytes)
      memory.title = `${appT('ramUsage')}: ${formatMemoryUsage(bytes)}`
    } catch {
      memoryValue.textContent = '—'
      memory.title = appT('ramUnavailable')
    } finally {
      memoryRequestActive = false
    }
  }

  const onDock = (event: Event): void => {
    entries = (event as CustomEvent<AgentDockEntry[]>).detail
    render()
  }
  window.addEventListener(AGENT_DOCK_EVENT, onDock)

  // Schedule the next RAM read during idle time (avoids contending with frame
  // rendering), but with a hard deadline so it still fires under sustained load.
  let idleHandle: ReturnType<typeof setTimeout> | number | undefined
  const scheduleRefresh = (): void => {
    idleHandle = window.setTimeout(() => {
      if (typeof requestIdleCallback !== 'undefined') {
        idleHandle = requestIdleCallback(() => void refreshMemory().finally(scheduleRefresh), { timeout: 2000 })
      } else {
        void refreshMemory().finally(scheduleRefresh)
      }
    }, 3000)
  }

  const onVisibilityChange = (): void => { if (!document.hidden) void refreshMemory().finally(scheduleRefresh) }
  document.addEventListener('visibilitychange', onVisibilityChange)
  element.replaceChildren(agents, memory)
  render()
  void refreshMemory().finally(scheduleRefresh)

  return {
    element,
    dispose: () => {
      window.removeEventListener(AGENT_DOCK_EVENT, onDock)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (typeof idleHandle === 'number') {
        clearTimeout(idleHandle)
        if (typeof cancelIdleCallback !== 'undefined') cancelIdleCallback(idleHandle)
      }
    },
  }
}
