import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { isRunning, parseContainers, type Container } from '../../core/docker/containers'
import type { Worktree } from '../../core/git/worktree'
import { buildTaskDevcontainerView } from './TaskDevcontainerView'
import { icon } from '../../ui/helpers/icons'
import { renderContainerLogs, renderContainerTerminal, type DetailLifecycle } from '../docker/containerDetail'
import { taskT } from './i18n'

export interface IsolateResult {
  subnet: string
  urls: { service: string; url: string }[]
  recipe?: RecipeApplyResult
}

export interface RecipeFilePreview {
  path: string
  action: 'create' | 'overwrite' | 'overwrite-tracked' | 'unchanged'
  tracked: boolean
}

export interface RecipePreview {
  projectKey: string
  recipeDir?: string
  recipeExists: boolean
  devcontainerDirs: string[]
  files: RecipeFilePreview[]
  warnings: string[]
}

export interface RecipeApplyResult {
  projectKey: string
  recipeDir: string
  devcontainerDir: string
  applied: string[]
  skipped: string[]
  errors: string[]
  appliedAt: number
}

interface TaskDockerViewOptions {
  showDetail: (...nodes: HTMLElement[]) => void
  resetDetail: () => void
  setLifecycle: (lifecycle: DetailLifecycle) => void
}

function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'tasks-icon-btn'
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = icon(name)
  button.addEventListener('click', onClick)
  return button
}

function note(text: string, className = 'tasks-note'): HTMLElement {
  return Object.assign(document.createElement('div'), { className, textContent: text })
}

function subHeader(title: string, goBack: () => void, ...extra: HTMLElement[]): HTMLElement {
  const header = document.createElement('div')
  header.className = 'tasks-sub-head'
  header.append(
    iconButton('arrow-left', taskT('back'), goBack),
    Object.assign(document.createElement('span'), { className: 'tasks-sub-title', textContent: title }),
    ...extra,
  )
  return header
}

export function createTaskDockerView(options: TaskDockerViewOptions) {
  const showContainerLogs = (container: Container, shortName: string, goBack: () => void): void => {
    options.resetDetail()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const body = document.createElement('div')
    body.className = 'tasks-logs-body'
    wrap.append(subHeader(shortName, goBack), body)
    options.showDetail(wrap)
    options.setLifecycle(renderContainerLogs(container, body))
  }

  const showContainerTerminal = async (container: Container, shortName: string, goBack: () => void): Promise<void> => {
    options.resetDetail()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const body = document.createElement('div')
    body.className = 'tasks-term-body'
    wrap.append(subHeader(shortName, goBack), body)
    options.showDetail(wrap)
    options.setLifecycle(await renderContainerTerminal(container, body, goBack))
  }

  const showStackLogs = (worktree: Worktree, worktreeDirectory: string, goBack: () => void): void => {
    options.resetDetail()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const logsBody = document.createElement('div')
    logsBody.className = 'tasks-logs-body'
    let live = false
    let resumeLive = false
    let disposed = false
    let streamGeneration = 0
    let unlisten: (() => void) | null = null
    const event = `docker-compose-logs-${worktreeDirectory}`
    const output = document.createElement('pre')
    output.className = 'docker-logs'

    const stopLiveStream = (): void => {
      if (!live) return
      live = false
      streamGeneration += 1
      liveButton.innerHTML = icon('play')
      liveButton.title = taskT('followLiveLogs')
      liveButton.classList.remove('active')
      invoke('docker_compose_logs_stop', { worktreePath: worktree.path }).catch(() => {})
      unlisten?.()
      unlisten = null
    }
    const stopLive = (): void => {
      resumeLive = false
      stopLiveStream()
    }
    const startLive = async (): Promise<void> => {
      if (disposed || live) return
      const generation = ++streamGeneration
      live = true
      liveButton.innerHTML = icon('stop')
      liveButton.title = taskT('stopFollowingLogs')
      liveButton.classList.add('active')
      output.textContent = ''
      try {
        await invoke('docker_compose_logs_follow', { worktreePath: worktree.path, tail: 200 })
        const stopListening = await listen<string>(event, eventData => {
          output.textContent += eventData.payload
          output.scrollTop = output.scrollHeight
        })
        if (disposed || !live || generation !== streamGeneration) stopListening()
        else unlisten = stopListening
      } catch (error) {
        output.textContent = String(error)
      }
    }

    const liveButton = iconButton('play', taskT('followLiveLogs'), () => live ? stopLive() : void startLive())
    const refreshButton = iconButton('refresh', taskT('reload'), () => {
      if (live) {
        stopLive()
        void startLive()
        return
      }
      output.textContent = taskT('loading')
      invoke<string>('docker_logs', { id: worktreeDirectory, tail: 500 })
        .catch(() => '')
        .then(result => { output.textContent = result || taskT('noLogs') })
    })
    const header = document.createElement('div')
    header.className = 'docker-logs-head'
    header.append(Object.assign(document.createElement('span'), { textContent: taskT('stackLogs') }), liveButton, refreshButton)
    logsBody.append(header, output)
    wrap.append(subHeader(taskT('stackLogs'), goBack), logsBody)
    options.showDetail(wrap)
    options.setLifecycle({
      pause: () => { resumeLive = live; stopLiveStream() },
      resume: () => { if (resumeLive && !disposed) { resumeLive = false; void startLive() } },
      dispose: () => { disposed = true; resumeLive = false; stopLiveStream() },
    })
    void startLive()
  }

  const show = (result: IsolateResult, worktree: Worktree): void => {
    options.resetDetail()
    const worktreeDirectory = worktree.path.replace(/\/$/, '').split('/').pop()!
    const wrap = document.createElement('div')
    wrap.className = 'tasks-docker-detail'
    const status = Object.assign(document.createElement('span'), { className: 'tasks-compose-status' })
    const up = iconButton('play', taskT('startStack'), async () => {
      up.disabled = true
      status.textContent = taskT('starting')
      await invoke('docker_compose_up', { worktreePath: worktree.path }).catch(error => { status.textContent = String(error) })
      up.disabled = false
      if (status.textContent === taskT('starting')) status.textContent = ''
    })
    const down = iconButton('stop', taskT('stopStack'), async () => {
      down.disabled = true
      status.textContent = taskT('stopping')
      await invoke('docker_compose_down', { worktreePath: worktree.path }).catch(error => { status.textContent = String(error) })
      down.disabled = false
      if (status.textContent === taskT('stopping')) status.textContent = ''
    })
    const stackLogs = iconButton('list', taskT('stackLogs'), () => showStackLogs(worktree, worktreeDirectory, () => show(result, worktree)))
    const controls = document.createElement('div')
    controls.className = 'tasks-compose-controls'
    controls.append(up, down, stackLogs, status)
    wrap.appendChild(controls)

    if (result.urls.length) {
      const urls = document.createElement('div')
      urls.className = 'tasks-url-list'
      for (const entry of result.urls) {
        const link = Object.assign(document.createElement('a'), { className: 'tasks-url-link', href: '#', textContent: `${entry.service} → ${entry.url}` })
        link.addEventListener('click', event => { event.preventDefault(); openUrl(entry.url).catch(() => {}) })
        urls.appendChild(link)
      }
      wrap.appendChild(urls)
    }

    const containers = document.createElement('div')
    containers.className = 'tasks-container-list'
    wrap.appendChild(containers)
    const refresh = async (): Promise<void> => {
      const mine = parseContainers(await invoke<string>('docker_list').catch(() => ''))
        .filter(container => container.name.startsWith(`${worktreeDirectory}-`))
      containers.replaceChildren()
      if (!mine.length) {
        containers.appendChild(note(taskT('emptyContainers')))
        return
      }
      for (const container of mine) {
        const shortName = container.name.slice(worktreeDirectory.length + 1)
        const running = isRunning(container)
        const row = document.createElement('div')
        row.className = 'tasks-ctr-row'
        const dot = Object.assign(document.createElement('span'), { className: `docker-dot ${running ? 'docker-up' : 'docker-down'}` })
        const label = Object.assign(document.createElement('span'), { className: 'tasks-ctr-name', textContent: shortName })
        const buttons = document.createElement('div')
        buttons.className = 'tasks-ctr-btns'
        const restart = iconButton(running ? 'power' : 'play', running ? taskT('restart') : taskT('start'), async () => {
          await invoke(running ? 'docker_restart' : 'docker_start', { id: container.name }).catch(() => {})
          void refresh()
        })
        const logs = iconButton('list', 'Logs', () => showContainerLogs(container, shortName, () => show(result, worktree)))
        const terminal = iconButton('terminal', 'Terminal', () => void showContainerTerminal(container, shortName, () => show(result, worktree)))
        logs.disabled = !running
        terminal.disabled = !running
        buttons.append(restart, logs, terminal)
        row.append(dot, label, buttons)
        containers.appendChild(row)
      }
    }
    void refresh()
    let pollInterval: ReturnType<typeof setInterval> | null = setInterval(refresh, 3000)
    const stopPoll = (): void => { if (pollInterval !== null) { clearInterval(pollInterval); pollInterval = null } }
    const resumePoll = (): void => { stopPoll(); void refresh(); pollInterval = setInterval(refresh, 3000) }
    options.setLifecycle({ pause: stopPoll, resume: resumePoll, dispose: stopPoll })
    options.showDetail(wrap)
  }

  const isolate = async (worktree: Worktree): Promise<void> => {
    options.resetDetail()
    try {
      show(await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: worktree.path }), worktree)
    } catch (error) {
      const message = String(error)
      options.showDetail(note(message === 'no-compose' ? taskT('noCompose') : message, message === 'no-compose' ? 'db-detail-hint' : 'db-detail-error'))
    }
  }

  // Devcontainer projects are launched by VS Code, not bento: we only *prepare*
  // the worktree (isolated compose) and point the user to "Reopen in Container".
  const { showDevcontainer, prepareDevcontainer, showDevcontainerUrls } =
    buildTaskDevcontainerView({ showDetail: options.showDetail, resetDetail: options.resetDetail })


  return { isolate, show, showDevcontainer, prepareDevcontainer, showDevcontainerUrls }
}
