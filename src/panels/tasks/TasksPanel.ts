import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { open as pickFolder, confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import { parseWorktreeList, parseStatus, taskBranch, taskPath, type Worktree } from '../../core/git/worktree'
import { parseContainers, isRunning, type Container } from '../../core/docker/containers'
import { renderContainerLogs, renderContainerTerminal } from '../docker/containerDetail'
import { showContextMenu } from '../../ui/contextMenu'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'

interface IsolateResult {
  subnet: string
  urls: { service: string; url: string }[]
}

const REPO_KEY = 'bento.tasks.repo'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function createTasksPanel(): { element: HTMLElement } {
  let worktrees: Worktree[] = []
  let repoPath = localStorage.getItem(REPO_KEY) ?? ''
  let detailCleanup: () => void = () => {}
  let selectedRow: HTMLElement | null = null
  let filterText = ''
  let lastStatuses = new Map<string, number>()
  let lastRunningPaths = new Set<string>()
  let baseBranch = 'main'

  const selectRow = (row: HTMLElement): void => {
    selectedRow?.classList.remove('tasks-row--selected')
    selectedRow = row
    row.classList.add('tasks-row--selected')
  }

  const root = document.createElement('div')
  root.className = 'tasks-panel'

  // ---- header ----
  const header = document.createElement('div')
  header.className = 'tasks-header'
  const titleEl = document.createElement('span')
  titleEl.className = 'tasks-title'
  titleEl.textContent = 'Tareas'
  const repoBtn = document.createElement('button')
  repoBtn.className = 'tasks-repo-btn'
  repoBtn.title = 'Seleccionar repositorio'
  const updateRepoBtn = (): void => {
    const name = repoPath ? repoPath.replace(/\/$/, '').split('/').pop()! : 'Seleccionar repo…'
    repoBtn.innerHTML = `${icon('folder')}<span>${name}</span>`
  }
  updateRepoBtn()
  repoBtn.addEventListener('click', async () => {
    const picked = await pickFolder({ directory: true, defaultPath: repoPath || undefined }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked
    localStorage.setItem(REPO_KEY, repoPath)
    updateRepoBtn()
    load()
  })
  const refreshBtn = iconBtn('refresh', 'Recargar', () => load())
  header.append(titleEl, repoBtn, refreshBtn)

  // ---- layout ----
  const body = document.createElement('div')
  body.className = 'tasks-body'

  const sidebar = document.createElement('div')
  sidebar.className = 'tasks-sidebar'

  // Filter input — lives outside listWrap so it persists across re-renders
  const filterInput = Object.assign(document.createElement('input'), {
    className: 'tasks-filter-input',
    type: 'search',
    placeholder: 'Filtrar tareas…',
  })
  filterInput.addEventListener('input', () => { filterText = filterInput.value; applyFilter() })

  const listWrap = document.createElement('div')
  listWrap.className = 'tasks-list-wrap'

  sidebar.append(filterInput, listWrap)

  const detailPane = document.createElement('div')
  detailPane.className = 'tasks-detail'
  body.append(sidebar, detailPane)
  root.append(header, body)

  const note = (text: string, cls = 'tasks-note'): HTMLElement =>
    Object.assign(document.createElement('div'), { className: cls, textContent: text })

  const showDetail = (...nodes: HTMLElement[]): void => { detailPane.replaceChildren(...nodes) }

  showDetail(note('Selecciona una tarea para ver sus cambios.', 'db-detail-hint'))

  // ---- list ----
  function renderList(statuses: Map<string, number>, runningPaths: Set<string>): void {
    lastStatuses = statuses
    lastRunningPaths = runningPaths
    applyFilter()
  }

  function applyFilter(): void {
    const lf = filterText.toLowerCase()
    const filtered = filterText
      ? worktrees.filter(wt => (wt.branch ?? '').toLowerCase().includes(lf) || wt.path.toLowerCase().includes(lf))
      : worktrees

    listWrap.replaceChildren()
    if (filtered.length === 0) {
      listWrap.append(
        note(worktrees.length === 0 ? 'No hay worktrees en este repo.' : 'Sin resultados.'),
        buildCreateForm(),
      )
      return
    }
    const list = document.createElement('div')
    list.className = 'tasks-list'
    filtered.forEach((wt, i) => {
      const isMain = i === 0 && !filterText
      list.appendChild(buildRow(wt, isMain, lastStatuses.get(wt.path) ?? 0, lastRunningPaths.has(wt.path)))
    })
    listWrap.append(list, buildCreateForm())
  }

  function buildRow(wt: Worktree, isMain: boolean, changes: number, hasRunning: boolean): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tasks-row'

    // Running containers dot
    const runDot = document.createElement('span')
    runDot.className = `tasks-run-dot ${hasRunning ? 'docker-up' : ''}`
    runDot.title = hasRunning ? 'Contenedores corriendo' : 'Sin contenedores'

    const branchEl = Object.assign(document.createElement('span'), { className: 'tasks-branch', textContent: wt.branch ?? '(detached)' })
    if (isMain) branchEl.title = 'worktree principal'

    const pathEl = Object.assign(document.createElement('span'), { className: 'tasks-path', textContent: wt.path.replace(/\/$/, '').split('/').slice(-2).join('/'), title: wt.path })

    const left = document.createElement('div')
    left.className = 'tasks-row-left'
    left.append(branchEl, pathEl)

    const badge = Object.assign(document.createElement('span'), {
      className: `tasks-badge${changes > 0 ? ' tasks-badge--dirty' : ''}`,
      textContent: changes > 0 ? `${changes} cambios` : 'limpio',
    })

    const flashBadge = (text: string, cls: string, ms: number): void => {
      const prev = badge.textContent ?? ''
      const prevCls = badge.className
      badge.textContent = text.split('\n')[0]?.slice(0, 28) ?? ''
      badge.className = `tasks-badge ${cls}`
      setTimeout(() => { badge.textContent = prev; badge.className = prevCls }, ms)
    }
    const runSync = async (mode: 'fetch' | 'merge' | 'rebase'): Promise<void> => {
      // merge/rebase rewrite the working tree — refuse if there are uncommitted changes.
      const needsCleanTree = mode !== 'fetch'
      if (needsCleanTree) {
        const status = await invoke<string>('git_status', { path: wt.path }).catch(() => '')
        const hasChanges = parseStatus(status).total > 0
        if (hasChanges) {
          flashBadge('Hay cambios sin commitear', 'tasks-badge--error', 4500)
          return
        }
      }
      flashBadge('Sincronizando…', '', 60000)
      try {
        const out = await invoke<string>('git_sync', { path: wt.path, base: baseBranch, mode })
        flashBadge(out.trim() || 'Ya al día', 'tasks-badge--ok', 3000)
        load()
      } catch (e) {
        flashBadge('Error al sincronizar', 'tasks-badge--error', 4000)
        selectRow(row)
        showSyncError(mode, String(e))
      }
    }

    const menuItems = () => {
      const items = [
        { label: 'Ver cambios', onClick: () => { selectRow(row); showChanges(wt) } },
        { label: 'Abrir en editor', onClick: () => { invoke('open_in_editor', { path: wt.path }).catch(console.error) } },
      ]
      if (!isMain) {
        items.push(
          { label: 'Docker', onClick: () => { selectRow(row); isolateDocker(wt) } },
          { label: `Fetch origin`, onClick: () => runSync('fetch') },
          { label: `Merge origin/${baseBranch}`, onClick: () => runSync('merge') },
          { label: `Rebase sobre origin/${baseBranch}`, onClick: () => runSync('rebase') },
          { label: 'Eliminar tarea', onClick: () => deleteWorktree(wt) },
        )
      }
      return items
    }

    const menuBtn = iconBtn('more', 'Acciones', () => {
      const r = menuBtn.getBoundingClientRect()
      showContextMenu(r.right - 4, r.bottom, menuItems())
    })
    const actions = document.createElement('div')
    actions.className = 'tasks-actions'
    actions.appendChild(menuBtn)

    // Row click shows changes (the primary action); right-click opens the menu too.
    row.addEventListener('click', () => { selectRow(row); showChanges(wt) })
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      selectRow(row)
      showContextMenu(e.clientX, e.clientY, menuItems())
    })
    row.append(runDot, left, badge, actions)
    return row
  }

  function buildCreateForm(): HTMLElement {
    const form = document.createElement('div')
    form.className = 'tasks-create'
    const input = Object.assign(document.createElement('input'), { className: 'tasks-name-input', type: 'text', placeholder: 'Nueva tarea…' })
    const btn = iconBtn('plus', 'Crear tarea', () => createTask(input.value.trim()))
    input.addEventListener('keydown', e => { if (e.key === 'Enter') createTask(input.value.trim()) })
    form.append(input, btn)
    return form
  }

  // ---- detail: changes (GitHub-style expandable diff) ----
  async function showChanges(wt: Worktree): Promise<void> {
    detailCleanup(); detailCleanup = () => {}
    showDetail(note('Cargando cambios…', 'db-detail-loading'))
    try {
      const raw = await invoke<string>('git_diff', { path: wt.path })
      showDetail(buildDiffView(raw))
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function buildDiffView(raw: string): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'tasks-diff'

    if (!raw.trim()) {
      wrap.appendChild(note('Sin cambios no confirmados.', 'db-detail-hint'))
      return wrap
    }

    // Split into per-file chunks on "diff --git" boundaries
    const chunks = raw.split(/(?=^diff --git )/m).filter(Boolean)

    for (const chunk of chunks) {
      const firstLine = chunk.split('\n')[0] ?? ''
      const match = firstLine.match(/^diff --git a\/(.+) b\//)
      const fileName = match?.[1] ?? firstLine

      const lines = chunk.split('\n')
      let additions = 0, deletions = 0
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++
      }

      const details = document.createElement('details')
      details.className = 'tasks-diff-file'

      const summary = document.createElement('summary')
      summary.className = 'tasks-diff-summary'

      const nameEl = Object.assign(document.createElement('span'), { className: 'tasks-diff-name', textContent: fileName })
      const stats = document.createElement('span')
      stats.className = 'tasks-diff-stats'
      if (additions > 0) stats.innerHTML += `<span class="tasks-diff-add">+${additions}</span>`
      if (deletions > 0) stats.innerHTML += `<span class="tasks-diff-del">-${deletions}</span>`
      summary.append(nameEl, stats)

      const pre = document.createElement('pre')
      pre.className = 'tasks-diff-body'
      pre.innerHTML = lines.map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="tasks-diff-line-add">${escHtml(line)}</span>`
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="tasks-diff-line-del">${escHtml(line)}</span>`
        if (line.startsWith('@@')) return `<span class="tasks-diff-hunk">${escHtml(line)}</span>`
        return `<span>${escHtml(line)}</span>`
      }).join('\n')

      details.append(summary, pre)
      wrap.appendChild(details)
    }

    return wrap
  }

  // ---- detail: git sync error (with "explain with AI") ----
  function showSyncError(mode: string, errorText: string): void {
    detailCleanup(); detailCleanup = () => {}
    const wrap = document.createElement('div')
    wrap.className = 'tasks-sync-error'

    const head = document.createElement('div')
    head.className = 'tasks-sync-error-head'
    head.append(
      Object.assign(document.createElement('span'), { className: 'tasks-sync-error-title', textContent: `Error en ${mode}` }),
      iconBtn('chat', 'Explicar el error con IA', () => {
        askAi(`/explica este error de git al hacer \`${mode}\`:\n\n\`\`\`\n${errorText.slice(-8000)}\n\`\`\``, true)
      }),
    )

    const pre = Object.assign(document.createElement('pre'), { className: 'tasks-sync-error-body', textContent: errorText })
    wrap.append(head, pre)
    showDetail(wrap)
  }

  // ---- detail: docker ----
  async function isolateDocker(wt: Worktree): Promise<void> {
    detailCleanup(); detailCleanup = () => {}
    try {
      const result = await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: wt.path })
      buildDockerDetail(result, wt)
    } catch (e) {
      const msg = String(e)
      showDetail(note(msg === 'no-compose' ? 'No hay docker-compose.yml en este worktree.' : msg,
        msg === 'no-compose' ? 'db-detail-hint' : 'db-detail-error'))
    }
  }

  function buildDockerDetail(result: IsolateResult, wt: Worktree): void {
    detailCleanup()
    const worktreeDir = wt.path.replace(/\/$/, '').split('/').pop()!

    const wrap = document.createElement('div')
    wrap.className = 'tasks-docker-detail'

    // ── compose controls ──
    const statusLabel = Object.assign(document.createElement('span'), { className: 'tasks-compose-status' })

    const upBtn = iconBtn('play', 'Arrancar stack', async () => {
      upBtn.disabled = true; statusLabel.textContent = 'Arrancando…'
      await invoke('docker_compose_up', { worktreePath: wt.path }).catch(e => { statusLabel.textContent = String(e) })
      upBtn.disabled = false
      if (statusLabel.textContent === 'Arrancando…') statusLabel.textContent = ''
    })
    const downBtn = iconBtn('stop', 'Parar stack', async () => {
      downBtn.disabled = true; statusLabel.textContent = 'Parando…'
      await invoke('docker_compose_down', { worktreePath: wt.path }).catch(e => { statusLabel.textContent = String(e) })
      downBtn.disabled = false
      if (statusLabel.textContent === 'Parando…') statusLabel.textContent = ''
    })
    const stackLogsBtn = iconBtn('list', 'Logs del stack completo', () => showStackLogs(wt, worktreeDir))

    const controls = document.createElement('div')
    controls.className = 'tasks-compose-controls'
    controls.append(upBtn, downBtn, stackLogsBtn, statusLabel)
    wrap.appendChild(controls)

    // ── URLs ──
    if (result.urls.length > 0) {
      const urlList = document.createElement('div')
      urlList.className = 'tasks-url-list'
      for (const { service, url } of result.urls) {
        const a = Object.assign(document.createElement('a'), { className: 'tasks-url-link', href: '#', textContent: `${service} → ${url}` })
        a.addEventListener('click', e => { e.preventDefault(); openUrl(url).catch(() => {}) })
        urlList.appendChild(a)
      }
      wrap.appendChild(urlList)
    }

    // ── container list (auto-refresh) ──
    const containerList = document.createElement('div')
    containerList.className = 'tasks-container-list'
    wrap.appendChild(containerList)

    const refresh = async (): Promise<void> => {
      const all = parseContainers(await invoke<string>('docker_list').catch(() => ''))
      const mine = all.filter(c => c.name.startsWith(`${worktreeDir}-`))
      containerList.replaceChildren()
      if (mine.length === 0) {
        containerList.appendChild(note('Sin contenedores — pulsa ▶ para arrancar.', 'tasks-note'))
        return
      }
      for (const c of mine) {
        const shortName = c.name.slice(worktreeDir.length + 1)
        const running = isRunning(c)
        const row = document.createElement('div')
        row.className = 'tasks-ctr-row'
        const dot = Object.assign(document.createElement('span'), { className: `docker-dot ${running ? 'docker-up' : 'docker-down'}` })
        const lbl = Object.assign(document.createElement('span'), { className: 'tasks-ctr-name', textContent: shortName })
        const btns = document.createElement('div')
        btns.className = 'tasks-ctr-btns'
        const restartBtn = iconBtn(running ? 'power' : 'play', running ? 'Reiniciar' : 'Arrancar', async () => {
          await invoke(running ? 'docker_restart' : 'docker_start', { id: c.name }).catch(() => {})
          refresh()
        })
        const logsBtn = iconBtn('list', 'Logs', () => showContainerLogs(c, shortName, () => buildDockerDetail(result, wt)))
        const termBtn = iconBtn('terminal', 'Terminal', () => showContainerTerminal(c, shortName, () => buildDockerDetail(result, wt)))
        logsBtn.disabled = !running; termBtn.disabled = !running
        btns.append(restartBtn, logsBtn, termBtn)
        row.append(dot, lbl, btns)
        containerList.appendChild(row)
      }
    }

    refresh()
    const interval = setInterval(refresh, 3000)
    detailCleanup = () => clearInterval(interval)
    showDetail(wrap)
  }

  // ---- stack logs ----
  function showStackLogs(wt: Worktree, worktreeDir: string): void {
    detailCleanup()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const logsBody = document.createElement('div')
    logsBody.className = 'tasks-logs-body'

    let rawLogs = '', live = false
    let unlisten: (() => void) | null = null
    const event = `docker-compose-logs-${worktreeDir}`

    const pre = document.createElement('pre')
    pre.className = 'docker-logs'

    const stopLive = (): void => {
      if (!live) return
      live = false
      liveBtn.innerHTML = icon('play'); liveBtn.title = 'Seguir logs en vivo'; liveBtn.classList.remove('active')
      invoke('docker_compose_logs_stop', { worktreePath: wt.path }).catch(() => {})
      unlisten?.(); unlisten = null
    }
    const startLive = async (): Promise<void> => {
      live = true
      liveBtn.innerHTML = icon('stop'); liveBtn.title = 'Parar el seguimiento'; liveBtn.classList.add('active')
      rawLogs = ''; pre.textContent = ''
      try {
        await invoke('docker_compose_logs_follow', { worktreePath: wt.path, tail: 200 })
        unlisten = await listen<string>(event, e => {
          rawLogs += e.payload; pre.textContent += e.payload; pre.scrollTop = pre.scrollHeight
        })
      } catch (e) { pre.textContent = String(e) }
    }

    const liveBtn = iconBtn('play', 'Seguir logs en vivo', () => live ? stopLive() : startLive())
    const refreshBtn = iconBtn('refresh', 'Recargar', () => {
      if (live) { stopLive(); startLive() } else {
        pre.textContent = 'Cargando…'
        invoke<string>('docker_logs', { id: worktreeDir, tail: 500 }).catch(() => '').then(r => { rawLogs = r; pre.textContent = r || '(sin logs)' })
      }
    })

    const head = document.createElement('div')
    head.className = 'docker-logs-head'
    head.append(Object.assign(document.createElement('span'), { textContent: 'Stack logs' }), liveBtn, refreshBtn)

    logsBody.append(head, pre)
    wrap.append(buildSubHead('Stack logs', () => buildDockerDetail({ subnet: '', urls: [] } as IsolateResult, wt)), logsBody)
    showDetail(wrap)
    detailCleanup = stopLive

    // Start live immediately
    startLive()
  }

  // ---- container: logs ----
  function showContainerLogs(c: Container, shortName: string, goBack: () => void): void {
    detailCleanup()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const logsBody = document.createElement('div')
    logsBody.className = 'tasks-logs-body'
    wrap.append(buildSubHead(shortName, goBack), logsBody)
    showDetail(wrap)
    detailCleanup = renderContainerLogs(c, logsBody)
  }

  // ---- container: terminal ----
  async function showContainerTerminal(c: Container, shortName: string, goBack: () => void): Promise<void> {
    detailCleanup()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const termBody = document.createElement('div')
    termBody.className = 'tasks-term-body'
    wrap.append(buildSubHead(shortName, goBack), termBody)
    showDetail(wrap)
    detailCleanup = await renderContainerTerminal(c, termBody, goBack)
  }

  function buildSubHead(title: string, goBack: () => void, ...extra: HTMLElement[]): HTMLElement {
    const head = document.createElement('div')
    head.className = 'tasks-sub-head'
    head.append(iconBtn('arrow-left', 'Volver', goBack), Object.assign(document.createElement('span'), { className: 'tasks-sub-title', textContent: title }), ...extra)
    return head
  }

  // ---- mutations ----
  async function createTask(name: string): Promise<void> {
    if (!name || !repoPath) return
    const branch = taskBranch(name)
    const path = taskPath(repoPath, branch.slice('feat/'.length))
    listWrap.replaceChildren(note('Creando tarea…', 'db-detail-loading'))
    try {
      const base = await invoke<string>('git_default_branch', { repo: repoPath })
      await invoke('git_worktree_add', { repo: repoPath, path, branch, base })
      await load()
      const wt = worktrees.find(w => w.path === path)
      const result = await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: path }).catch((e: unknown) => {
        const msg = String(e); if (msg !== 'no-compose') showDetail(note(msg, 'db-detail-error')); return null
      })
      if (result && wt) buildDockerDetail(result, wt)
    } catch (e) { listWrap.replaceChildren(note(String(e), 'db-detail-error')) }
  }

  async function deleteWorktree(wt: Worktree): Promise<void> {
    const { total } = parseStatus(await invoke<string>('git_status', { path: wt.path }).catch(() => ''))
    const ok = await askConfirm(
      total > 0 ? `"${wt.branch}" tiene ${total} cambios sin commitear. ¿Eliminar igualmente?` : `¿Eliminar la tarea "${wt.branch}"?`,
      { title: 'Eliminar tarea', kind: total > 0 ? 'warning' : 'info' },
    )
    if (!ok) return
    try {
      await invoke('docker_compose_down', { worktreePath: wt.path }).catch(() => {})
      await invoke('git_worktree_remove', { repo: repoPath, path: wt.path, force: total > 0, branch: wt.branch ?? null })
      showDetail(note('Selecciona una tarea para ver sus cambios.', 'db-detail-hint'))
      await load()
    } catch (e) { await askConfirm(String(e), { title: 'Error', kind: 'error' }) }
  }

  // ---- load ----
  async function load(): Promise<void> {
    if (!repoPath) {
      filterInput.style.display = 'none'
      listWrap.replaceChildren(note('Selecciona un repositorio con el botón de arriba.'), buildCreateForm())
      return
    }
    filterInput.style.display = ''
    listWrap.replaceChildren(note('Cargando…', 'db-detail-loading'))
    try {
      baseBranch = await invoke<string>('git_default_branch', { repo: repoPath }).catch(() => 'main')
      worktrees = parseWorktreeList(await invoke<string>('git_worktree_list', { repo: repoPath }))
      const [statuses, allContainers] = await Promise.all([
        Promise.all(worktrees.map(async wt => {
          const s = await invoke<string>('git_status', { path: wt.path }).catch(() => '')
          return [wt.path, parseStatus(s).total] as [string, number]
        })).then(entries => new Map(entries)),
        invoke<string>('docker_list').catch(() => '').then(parseContainers),
      ])
      const runningPaths = new Set<string>()
      for (const wt of worktrees) {
        const dir = wt.path.replace(/\/$/, '').split('/').pop()!
        const hasRunning = allContainers.some(c => isRunning(c) && c.name.startsWith(`${dir}-`))
        if (hasRunning) runningPaths.add(wt.path)
      }
      renderList(statuses, runningPaths)
    } catch (e) { listWrap.replaceChildren(note(String(e), 'db-detail-error')) }
  }

  function iconBtn(name: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'docker-action'
    b.title = title
    b.innerHTML = icon(name)
    b.addEventListener('click', e => { e.stopPropagation(); onClick() })
    return b
  }

  filterInput.style.display = 'none'
  load()
  return { element: root }
}
