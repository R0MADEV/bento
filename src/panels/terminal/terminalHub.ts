import { icon } from '../../ui/icons'
import { appT } from '../../core/i18n'
import type { PanelInstance, PanelApi } from '../registry'
import type { AgentStore } from '../../core/terminal/agentStore'
import type { TerminalPanelHandle } from './TerminalPanel'

interface TabEntry {
  handle: TerminalPanelHandle
  wrapper: HTMLDivElement
  tab: HTMLButtonElement
}

export function createTerminalHub(panelId: string, projectPath: string, store?: AgentStore): PanelInstance {
  const root = document.createElement('div')
  root.className = 'terminal-hub'

  const tabBar = document.createElement('div')
  tabBar.className = 'terminal-hub-bar'

  const content = document.createElement('div')
  content.className = 'terminal-hub-content'

  root.append(tabBar, content)

  const tabs: TabEntry[] = []
  let activeIdx = 0
  let readyApi: PanelApi | undefined
  let disposed = false

  const activate = (idx: number): void => {
    activeIdx = idx
    tabs.forEach(({ wrapper, tab }, i) => {
      const isActive = i === idx
      wrapper.classList.toggle('terminal-hub-active', isActive)
      tab.classList.toggle('active', isActive)
    })
    tabs[idx]?.handle.focus()
  }

  const removeTab = (idx: number): void => {
    if (tabs.length <= 1) return
    tabs[idx].handle.dispose()
    tabs[idx].tab.remove()
    tabs[idx].wrapper.remove()
    tabs.splice(idx, 1)
    activate(Math.min(idx, tabs.length - 1))
  }

  const addTab = (projectDir = projectPath): void => {
    const tabIdx = tabs.length
    const tabId = `${panelId}-tab-${tabIdx}-${Date.now()}`

    const wrapper = document.createElement('div')
    wrapper.className = 'terminal-hub-instance'
    content.appendChild(wrapper)

    // Import lazily to stay consistent with how definition.ts loads the panel.
    void import('./TerminalPanel').then(({ createTerminalPanel }) => {
      if (disposed) return
      const handle = createTerminalPanel(tabId, projectDir, undefined, undefined, store)

      wrapper.appendChild(handle.element)
      if (readyApi) handle.onReady(readyApi)
      handle.onTitleChange(title => {
        const textNode = tab.querySelector('.terminal-hub-tab-label')
        if (textNode) textNode.textContent = title
      })
      tabs[tabIdx].handle = handle
      if (tabIdx === activeIdx) {
        wrapper.classList.add('terminal-hub-active')
        handle.focus()
      }
    })

    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'terminal-hub-tab'
    tab.addEventListener('click', () => activate(tabs.findIndex(t => t.tab === tab)))

    const label = document.createElement('span')
    label.className = 'terminal-hub-tab-label'
    label.textContent = appT('panelTerminal')

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'terminal-hub-tab-close'
    closeBtn.innerHTML = icon('x')
    closeBtn.title = appT('closePanel')
    closeBtn.addEventListener('click', e => {
      e.stopPropagation()
      removeTab(tabs.findIndex(t => t.tab === tab))
    })

    tab.append(label, closeBtn)
    tabBar.insertBefore(tab, addBtn)

    // Placeholder handle until the async import resolves.
    tabs.push({ handle: null as unknown as TerminalPanelHandle, wrapper, tab })
    activate(tabIdx)
  }

  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'terminal-hub-add'
  addBtn.title = 'Nueva terminal'
  addBtn.textContent = '+'
  addBtn.addEventListener('click', () => addTab())
  tabBar.appendChild(addBtn)

  addTab()

  return {
    element: root,
    fit: () => tabs[activeIdx]?.handle?.fit?.(),
    focus: () => tabs[activeIdx]?.handle?.focus?.(),
    dispose: () => {
      disposed = true
      tabs.forEach(t => t.handle?.dispose?.())
    },
    onTitleChange: cb => {
      // Reflect the active tab's title as the panel title.
      const update = (title: string) => cb(title)
      tabs[activeIdx]?.handle?.onTitleChange(update)
      return () => {}
    },
    onReady: api => {
      readyApi = api
      tabs.forEach(t => t.handle?.onReady?.(api))
    },
    onVisibilityChange: visible => {
      tabs.forEach(t => t.handle?.fit?.())
      if (visible) tabs[activeIdx]?.handle?.focus?.()
    },
    getCwd: () => tabs[activeIdx]?.handle?.getCwd?.(),
  }
}
