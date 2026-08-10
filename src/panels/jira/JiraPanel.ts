import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { basicAuth } from '../../core/jira/auth'
import { apiUrl, browseUrl } from '../../core/jira/urls'
import { parseIssues, type JiraIssue } from '../../core/jira/issues'
import { parseBulkIssues } from '../../core/jira/bulk'
import { MY_OPEN_ISSUES } from '../../core/jira/jql'
import { groupByCategory, boardCategory, parseAgileBoards, parseAgileColumns, mapToAgileColumns, type AgileBoard, type AgileColumn } from '../../core/jira/board'
import { jiraWikiToHtml } from '../../core/jira/wikiMarkup'
import { icon } from '../../ui/icons'
import { createMasterDetail } from '../../ui/masterDetail'

interface JiraAccount { id: string; site: string; email: string; token: string }
interface HttpResponse { status: number; body: string }

export function createJiraPanel(): { element: HTMLElement } {
  let accounts: JiraAccount[] = []
  let activeAccount: JiraAccount | null = null

  // ---- build master-detail shell ----
  const addBtn = mkBtn('plus', 'Añadir cuenta', () => showConfig())

  const md = createMasterDetail({
    title: 'Jira',
    resizableSidebar: { storageKey: 'bento.jira.sidebarWidth', minWidth: 180, minRemaining: 420 },
    headerActions: [addBtn],
    onSelect: id => {
      const next = accounts.find(a => a.id === id) ?? null
      const isAccountSwitch = next?.id !== activeAccount?.id
      if (isAccountSwitch) {
        agileBoards = []
        selectedBoardId = null
        agileColumns = []
        cachedIssues = []
        activeAssigneeId = ''
      }
      activeAccount = next
      if (activeAccount) showIssues()
    },
    groupActions: (group) => [mkBtn('trash', 'Eliminar cuenta', async () => {
      await invoke('jira_account_delete', { id: group }).catch(() => {})
      await loadAccounts()
    })],
    emptyText: 'Sin cuentas. Usa + para añadir una.',
  })

  // Accounts live one-per-group so the trash button appears per account.
  const loadAccounts = async (): Promise<void> => {
    accounts = await invoke<JiraAccount[]>('jira_accounts_get').catch(() => [] as JiraAccount[])
    md.setItems(accounts.map(a => ({ id: a.id, label: a.email, group: a.id })))
    if (!accounts.length) {
      showHint('Sin cuentas. Usa + para añadir una.')
    } else if (!activeAccount || !accounts.find(a => a.id === activeAccount!.id)) {
      showHint('Selecciona una cuenta.')
    }
  }

  // ---- API ----
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (!activeAccount) throw new Error('No account selected')
    const res = await invoke<HttpResponse>('http_request', {
      method,
      url: apiUrl(activeAccount.site, path),
      headers: [
        ['Authorization', basicAuth(activeAccount.email, activeAccount.token)],
        ['Accept', 'application/json'],
        ['Content-Type', 'application/json'],
      ],
      body: body !== undefined ? JSON.stringify(body) : null,
    })
    if (res.status >= 400) throw new Error(`HTTP ${res.status} — ${res.body.slice(0, 300)}`)
    return res.body ? JSON.parse(res.body) : null
  }

  const searchIssues = async (jql: string): Promise<JiraIssue[]> => {
    const json = await api('POST', 'api/3/search/jql', {
      jql,
      fields: ['summary', 'status', 'issuetype', 'assignee'],
      maxResults: 50,
    })
    return parseIssues(json)
  }

  interface IssueDetail {
    description: string
    isRenderedHtml: boolean
    attachments: Array<{ id: string; filename: string; content: string; thumbnail: string; mimeType: string }>
    pullRequests: Array<{ title: string; url: string; status: string }>
    assignee: string; assigneeAvatar: string
    reporter: string; reporterAvatar: string
    priority: string
    sprint: string
    fixVersions: string[]
    estimate: string
  }

  // Fetch a binary asset (image) with Jira auth and return as a base64 data URL.
  const fetchAsDataUrl = (url: string): Promise<string> =>
    invoke<string>('http_fetch_base64', {
      url,
      headers: [
        ['Authorization', basicAuth(activeAccount!.email, activeAccount!.token)],
      ],
    })

  const fetchIssueDetail = async (key: string): Promise<IssueDetail> => {
    const json = await api('GET', `api/2/issue/${key}?fields=description,attachment,assignee,reporter,priority,customfield_10020,fixVersions,timeoriginalestimate&expand=renderedFields`) as {
      renderedFields?: { description?: string }
      fields?: {
        description?: string
        attachment?: Array<{ id?: string; filename?: string; content?: string; mimeType?: string; thumbnail?: string }>
        assignee?: { displayName?: string; avatarUrls?: { '48x48'?: string } }
        reporter?: { displayName?: string; avatarUrls?: { '48x48'?: string } }
        priority?: { name?: string }
        customfield_10020?: Array<{ name?: string }>
        fixVersions?: Array<{ name?: string }>
        timeoriginalestimate?: number
      }
    }
    const f = json?.fields ?? {}
    const attachments = (f.attachment ?? []).map(a => ({
      id: a.id ?? '',
      filename: a.filename ?? '',
      content: a.content ?? '',
      thumbnail: a.thumbnail ?? '',
      mimeType: a.mimeType ?? '',
    }))
    let pullRequests: IssueDetail['pullRequests'] = []
    try {
      const dev = await api('GET', `dev-info/0.10/issue/detail/${key}?_format=summary`) as {
        detail?: Array<{ pullRequests?: Array<{ title?: string; url?: string; status?: string }> }>
      }
      pullRequests = (dev?.detail ?? []).flatMap(d => d.pullRequests ?? []).map(pr => ({
        title: pr.title ?? '', url: pr.url ?? '', status: pr.status ?? '',
      }))
    } catch { /* not available on all instances */ }
    const secs = f.timeoriginalestimate
    const estimate = secs ? `${Math.round(secs / 3600)}h` : ''
    const renderedDesc = json?.renderedFields?.description
    return {
      description: renderedDesc ?? f.description ?? '',
      isRenderedHtml: !!renderedDesc,
      attachments,
      pullRequests,
      assignee: f.assignee?.displayName ?? '',
      assigneeAvatar: f.assignee?.avatarUrls?.['48x48'] ?? '',
      reporter: f.reporter?.displayName ?? '',
      reporterAvatar: f.reporter?.avatarUrls?.['48x48'] ?? '',
      priority: f.priority?.name ?? '',
      sprint: f.customfield_10020?.map(s => s.name).filter(Boolean).join(', ') ?? '',
      fixVersions: (f.fixVersions ?? []).map(v => v.name ?? '').filter(Boolean),
      estimate,
    }
  }

  const createIssue = (project: string, type: string, summary: string, description: string, accountId?: string): Promise<unknown> => {
    const fields: Record<string, unknown> = { project: { key: project }, issuetype: { name: type }, summary, description }
    if (accountId) fields.assignee = { accountId }
    return api('POST', 'api/2/issue', { fields })
  }

  const resolveAccountId = async (email: string): Promise<string | null> => {
    if (!email) return null
    const users = await api('GET', `api/2/user/search?query=${encodeURIComponent(email)}`) as Array<{ accountId?: string }>
    return Array.isArray(users) && users[0]?.accountId ? users[0].accountId : null
  }

  // ---- detail-pane helpers ----
  const showDetail = (...nodes: HTMLElement[]): void => { md.detail.replaceChildren(...nodes) }

  const showHint = (text: string): void => showDetail(note(text, 'jira-detail-hint'))

  const detailHeader = (title: string, ...actions: HTMLElement[]): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = 'jira-header'
    const h = document.createElement('span')
    h.className = 'jira-title'
    h.textContent = title
    bar.append(h, ...actions)
    return bar
  }

  const field = (label: string, value = '', type = 'text'): { row: HTMLElement; input: HTMLInputElement } => {
    const row = document.createElement('label')
    row.className = 'jira-field'
    row.textContent = label
    const input = document.createElement('input')
    input.className = 'jira-input'
    input.type = type
    input.value = value
    row.appendChild(input)
    return { row, input }
  }

  // ---- config form (shown in detail pane) ----
  const showConfig = (existing?: JiraAccount): void => {
    const siteF = field('Site (https://tuorg.atlassian.net)', existing?.site ?? '')
    const emailF = field('Email', existing?.email ?? '')
    const tokenF = field('API token', existing?.token ?? '', 'password')
    const hint = document.createElement('a')
    hint.className = 'jira-hint-link'
    hint.textContent = i18nT('jira.generateApiToken')
    hint.addEventListener('click', () => openUrl('https://id.atlassian.com/manage-profile/security/api-tokens').catch(() => {}))
    const save = document.createElement('button')
    save.className = 'jira-primary'
    save.textContent = 'Guardar'
    const status = note('')
    save.addEventListener('click', async () => {
      const s = siteF.input.value.trim()
      const e = emailF.input.value.trim()
      const t = tokenF.input.value.trim()
      if (!s || !e || !t) { status.textContent = 'Todos los campos son obligatorios.'; return }
      try {
        const acc = await invoke<JiraAccount>('jira_account_set', { site: s, email: e, token: t })
        await loadAccounts()
        activeAccount = acc
        md.select(acc.id)
        showIssues()
      } catch (err) {
        status.textContent = String(err)
      }
    })
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(siteF.row, emailF.row, tokenF.row, hint, save, status)
    showDetail(detailHeader(existing ? 'Editar cuenta' : 'Añadir cuenta'), body)
  }


  // ---- shared helpers ----
  const statusClass = (cat: string): string =>
    cat === 'done' ? 'jira-st-done' : cat === 'indeterminate' ? 'jira-st-progress' : 'jira-st-todo'

  let viewMode: 'list' | 'board' = 'board'
  let lastJql = MY_OPEN_ISSUES
  let cachedIssues: JiraIssue[] = []
  let agileBoards: AgileBoard[] = []
  let selectedBoardId: number | null = null
  let agileColumns: AgileColumn[] = []

  // ---- Agile board API ----
  const fetchAgileBoards = async (nameFilter = ''): Promise<AgileBoard[]> => {
    const q = nameFilter ? `&name=${encodeURIComponent(nameFilter)}` : ''
    const json = await api('GET', `agile/1.0/board?maxResults=100${q}`)
    return parseAgileBoards(json)
  }

  const fetchBoardColumns = async (boardId: number): Promise<AgileColumn[]> => {
    const json = await api('GET', `agile/1.0/board/${boardId}/configuration`)
    return parseAgileColumns(json)
  }

  // For scrum boards: fetch active sprint issues; for kanban: fetch board issues.
  const fetchBoardIssues = async (boardId: number): Promise<JiraIssue[]> => {
    // Try active sprint first (scrum boards)
    try {
      const sprintRes = await api('GET', `agile/1.0/board/${boardId}/sprint?state=active&maxResults=1`) as { values?: Array<{ id: number }> }
      const sprintId = sprintRes?.values?.[0]?.id
      if (sprintId) {
        const json = await api('GET', `agile/1.0/sprint/${sprintId}/issue?fields=summary,status,issuetype,assignee&maxResults=100`)
        return parseIssues(json)
      }
    } catch { /* not a scrum board or no active sprint — fall through */ }
    const json = await api('GET', `agile/1.0/board/${boardId}/issue?fields=summary,status,issuetype,assignee&maxResults=100`)
    return parseIssues(json)
  }

  // ---- issue list / board ----
  const showIssues = (jql = lastJql): void => {
    lastJql = jql
    if (!activeAccount) return

    const content = document.createElement('div')
    content.className = 'jira-view-content'

    const toggleBtn = mkBtn(
      viewMode === 'list' ? 'kanban' : 'list',
      viewMode === 'list' ? 'Vista tablero' : 'Vista lista',
      () => { viewMode = viewMode === 'list' ? 'board' : 'list'; showIssues(search.value) },
    )

    // Board search input with live suggestions — only shown in board mode
    const boardWrap = document.createElement('div')
    boardWrap.className = 'jira-board-search-wrap'
    const boardInput = document.createElement('input')
    boardInput.className = 'jira-board-select'
    boardInput.placeholder = 'Buscar tablero…'
    const boardDropdown = document.createElement('div')
    boardDropdown.className = 'jira-board-dropdown'
    boardWrap.append(boardInput, boardDropdown)

    const search = document.createElement('input')
    search.className = 'jira-search'
    search.value = jql
    search.placeholder = 'JQL…'

    const headerEl = detailHeader(
      activeAccount.id,
      mkBtn('plus', 'Nueva tarjeta', () => showCreate()),
      mkBtn('refresh', 'Recargar', () => load()),
      toggleBtn,
      mkBtn('settings', 'Editar cuenta', () => showConfig(activeAccount!)),
    )

    const renderContent = (issues: JiraIssue[]): void => {
      cachedIssues = issues
      content.replaceChildren()
      if (viewMode === 'board') {
        const cols = agileColumns.length ? agileColumns : null
        renderBoard(issues, content, cols)
      } else {
        renderList(issues, content)
      }
    }

    const loadBoard = async (boardId: number): Promise<void> => {
      activeAssigneeId = ''
      content.replaceChildren(note('Cargando tablero…'))
      try {
        agileColumns = await fetchBoardColumns(boardId)
        renderContent(await fetchBoardIssues(boardId))
      } catch (e) {
        content.replaceChildren(note(String(e), 'jira-error'))
      }
    }

    const loadList = async (q: string): Promise<void> => {
      content.replaceChildren(note('Cargando…'))
      try {
        renderContent(await searchIssues(q))
      } catch (e) {
        content.replaceChildren(note(String(e), 'jira-error'))
      }
    }

    const load = (): void => {
      if (viewMode === 'board' && selectedBoardId) loadBoard(selectedBoardId)
      else loadList(search.value)
    }

    // Board search with live suggestions
    const renderBoardDropdown = (boards: AgileBoard[]): void => {
      boardDropdown.replaceChildren()
      const q = boardInput.value.trim().toLowerCase()
      const visible = q ? boards.filter(b => b.name.toLowerCase().includes(q)) : boards
      if (!visible.length) { boardDropdown.classList.remove('open'); return }
      for (const b of visible) {
        const item = document.createElement('button')
        item.className = b.id === selectedBoardId ? 'jira-board-option active' : 'jira-board-option'
        item.textContent = b.name
        item.addEventListener('click', () => {
          selectedBoardId = b.id
          boardInput.value = b.name
          boardDropdown.classList.remove('open')
          loadBoard(b.id)
        })
        boardDropdown.append(item)
      }
      boardDropdown.classList.add('open')
    }

    const initBoardSearch = async (): Promise<void> => {
      boardInput.placeholder = 'Cargando tableros…'
      if (!agileBoards.length) {
        agileBoards = await fetchAgileBoards().catch(() => [])
      }
      boardInput.placeholder = 'Buscar tablero…'
      const current = agileBoards.find(b => b.id === selectedBoardId)
      if (current) boardInput.value = current.name

      let searchTimer: ReturnType<typeof setTimeout>
      boardInput.addEventListener('input', () => {
        clearTimeout(searchTimer)
        searchTimer = setTimeout(async () => {
          const q = boardInput.value.trim()
          if (q.length >= 2) {
            const fresh = await fetchAgileBoards(q).catch(() => [] as AgileBoard[])
            agileBoards = [...new Map([...agileBoards, ...fresh].map(b => [b.id, b])).values()]
          }
          renderBoardDropdown(agileBoards)
        }, 250)
      })
      boardInput.addEventListener('focus', () => renderBoardDropdown(agileBoards))
      boardInput.addEventListener('blur', () => setTimeout(() => boardDropdown.classList.remove('open'), 150))

      if (selectedBoardId) loadBoard(selectedBoardId)
      else content.replaceChildren(note('Busca y selecciona un tablero.'))
    }

    search.addEventListener('keydown', e => { if (e.key === 'Enter') loadList(search.value) })

    if (viewMode === 'board') {
      showDetail(headerEl, boardWrap, content)
      initBoardSearch()
    } else {
      showDetail(headerEl, search, content)
      loadList(jql)
    }
  }

  const renderList = (issues: JiraIssue[], container: HTMLElement): void => {
    if (!issues.length) { container.append(note('Sin resultados.')); return }
    const list = document.createElement('div')
    list.className = 'jira-list'
    issues.forEach(it => {
      const row = document.createElement('button')
      row.className = 'jira-issue'
      row.innerHTML =
        `<span class="jira-key">${it.key}</span>` +
        `<span class="jira-summary"></span>` +
        `<span class="jira-status ${statusClass(it.statusCategory)}">${it.status}</span>`
      row.querySelector('.jira-summary')!.textContent = it.summary
      row.addEventListener('click', () => showIssueDetail(it))
      list.appendChild(row)
    })
    container.append(list)
  }

  // ---- board view ----
  let activeAssigneeId = ''   // '' = show all

  const renderBoard = (issues: JiraIssue[], container: HTMLElement, cols: AgileColumn[] | null): void => {
    const wrap = document.createElement('div')
    wrap.className = 'jira-board-wrap'

    // Assignee filter bar — unique users with tasks on this board
    const assignees = [...new Map(
      issues.filter(i => i.assigneeId).map(i => [i.assigneeId, i])
    ).values()]

    if (assignees.length > 1) {
      const bar = document.createElement('div')
      bar.className = 'jira-assignee-bar'
      assignees.forEach(i => {
        const btn = makeAvatarBtn(i.assignee, i.assigneeId, i.assigneeAvatar, activeAssigneeId === i.assigneeId, () => {
          activeAssigneeId = activeAssigneeId === i.assigneeId ? '' : i.assigneeId
          renderBoard(issues, container, cols)
        })
        bar.append(btn)
      })
      wrap.append(bar)
    }

    const filtered = activeAssigneeId ? issues.filter(i => i.assigneeId === activeAssigneeId) : issues

    const board = document.createElement('div')
    board.className = 'jira-board'

    // Use real board columns if available, otherwise fall back to 3 generic ones
    const columns: { name: string; issues: JiraIssue[] }[] = cols
      ? [...mapToAgileColumns(filtered, cols).entries()].map(([name, iss]) => ({ name, issues: iss }))
      : (() => {
          const g = groupByCategory(filtered)
          return [
            { name: 'Por hacer', issues: g.todo },
            { name: 'En progreso', issues: g.inProgress },
            { name: 'Hecho', issues: g.done },
          ]
        })()

    for (const col of columns) {
      const colEl = document.createElement('div')
      colEl.className = 'jira-board-col'

      const colHeader = document.createElement('div')
      colHeader.className = 'jira-board-col-header'
      const colTitle = document.createElement('span')
      colTitle.textContent = col.name
      const colCount = document.createElement('span')
      colCount.className = 'jira-board-col-count'
      colCount.textContent = String(col.issues.length)
      colHeader.append(colTitle, colCount)

      const cards = document.createElement('div')
      cards.className = 'jira-board-cards'
      for (const issue of col.issues) cards.append(makeCard(issue, col.name))

      colEl.addEventListener('dragover', e => { e.preventDefault(); colEl.classList.add('drag-over') })
      colEl.addEventListener('dragleave', e => { if (!colEl.contains(e.relatedTarget as Node)) colEl.classList.remove('drag-over') })
      colEl.addEventListener('drop', async e => {
        e.preventDefault()
        colEl.classList.remove('drag-over')
        const key = e.dataTransfer?.getData('text/plain')
        const fromCol = e.dataTransfer?.getData('jira-from-col')
        if (!key || fromCol === col.name) return
        const card = board.querySelector(`[data-issue-key="${key}"]`) as HTMLElement | null
        if (card) card.classList.add('jira-card-moving')
        try {
          await doTransitionByColumn(key, col.name, cols)
          const issue = cachedIssues.find(i => i.key === key)
          if (issue) issue.status = col.name
          renderBoard(cachedIssues, container, cols)
        } catch {
          if (card) card.classList.remove('jira-card-moving')
        }
      })

      colEl.append(colHeader, cards)
      board.append(colEl)
    }

    wrap.append(board)
    container.replaceChildren(wrap)
  }

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
    card.addEventListener('click', () => showIssueDetail(issue))
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

  // Find and execute the right Jira transition to move an issue to a target column.
  const doTransitionByColumn = async (issueKey: string, targetColName: string, cols: AgileColumn[] | null): Promise<void> => {
    const res = await api('GET', `api/2/issue/${issueKey}/transitions`) as { transitions?: Array<{ id: string; name: string; to: { id: string; name: string; statusCategory: { key: string } } }> }
    const transitions = res?.transitions ?? []
    let match = transitions.find(t => t.to.name === targetColName || t.name === targetColName)
    if (!match && cols) {
      const targetCol = cols.find(c => c.name === targetColName)
      match = transitions.find(t => targetCol?.statusIds.includes(t.to.id))
    }
    if (!match) match = transitions.find(t => boardCategory(t.to.statusCategory.key) === boardCategory(agileColumns.find(c => c.name === targetColName)?.statusIds[0] ? 'indeterminate' : 'new'))
    if (!match) throw new Error(`No hay transición disponible hacia "${targetColName}"`)
    await api('POST', `api/2/issue/${issueKey}/transitions`, { transition: { id: match.id } })
  }

  // ---- issue detail (drawer — shown on top of the board, board state preserved) ----
  const showIssueDetail = async (it: JiraIssue): Promise<void> => {
    const close = (): void => { overlay.remove() }

    const overlay = document.createElement('div')
    overlay.className = 'jira-drawer-overlay'
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })

    const drawer = document.createElement('div')
    drawer.className = 'jira-drawer'

    const openBtn = mkBtn('globe', 'Abrir en Jira', () => openUrl(browseUrl(activeAccount!.site, it.key)).catch(() => {}))
    const closeBtn = mkBtn('x', 'Cerrar', close)

    const meta = document.createElement('div')
    meta.className = 'jira-detail-meta'
    const key = document.createElement('span')
    key.className = 'jira-key'
    key.textContent = it.key
    const status = document.createElement('span')
    status.className = `jira-status ${statusClass(it.statusCategory)}`
    status.textContent = it.status
    const issueType = document.createElement('span')
    issueType.className = 'jira-type'
    issueType.textContent = it.type
    meta.append(key, status, issueType)
    const summary = document.createElement('div')
    summary.className = 'jira-detail-summary'
    summary.textContent = it.summary
    // Two-column layout: description (left) + metadata (right)
    const body = document.createElement('div')
    body.className = 'jira-detail jira-detail-layout'

    const left = document.createElement('div')
    left.className = 'jira-detail-left'

    const right = document.createElement('div')
    right.className = 'jira-detail-right'

    const descEl = document.createElement('div')
    descEl.className = 'jira-detail-desc jira-wiki-body'
    descEl.textContent = 'Cargando…'
    left.append(meta, summary, descEl)

    body.append(left, right)
    drawer.append(detailHeader('Detalle', openBtn, closeBtn), body)

    fetchIssueDetail(it.key).then(async d => {
      // Render description: use Jira's pre-rendered HTML if available, else parse wiki markup
      const attachMap = new Map(d.attachments.map(a => [a.filename, a.content]))
      if (d.isRenderedHtml) {
        descEl.innerHTML = d.description || '<em>(sin descripción)</em>'
        // Replace image srcs with authenticated data URLs
        descEl.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('src')
          if (src) fetchAsDataUrl(src).then(data => { img.src = data }).catch(() => {})
        })
      } else {
        descEl.innerHTML = d.description
          ? jiraWikiToHtml(d.description, attachMap)
          : '<em>(sin descripción)</em>'
      }

      // Wire all links to open in browser
      descEl.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault()
          const href = a.getAttribute('href') || (a as HTMLElement).dataset.href
          if (href && href !== '#') openUrl(href).catch(() => {})
        })
      })
      descEl.querySelectorAll('.jira-wiki-link').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault()
          const href = (a as HTMLElement).dataset.href
          if (href) openUrl(href).catch(() => {})
        })
      })

      // Metadata sidebar
      const metaItems: Array<[string, string, string?]> = ([
        ['Asignado', d.assignee, d.assigneeAvatar] as [string, string, string?],
        ['Informador', d.reporter, d.reporterAvatar] as [string, string, string?],
        ['Prioridad', d.priority] as [string, string],
        ['Sprint', d.sprint] as [string, string],
        ['Estimación', d.estimate] as [string, string],
        ...(d.fixVersions.length ? [['Versiones', d.fixVersions.join(', ')] as [string, string]] : []),
      ]).filter(([, v]) => v)

      right.replaceChildren()
      metaItems.forEach(([label, value, avatar]) => {
        const row = document.createElement('div')
        row.className = 'jira-meta-row'
        if (label === 'Estimación') row.dataset.field = 'estimate'
        const lbl = document.createElement('span')
        lbl.className = 'jira-meta-label'
        lbl.textContent = label.toUpperCase()
        const val = document.createElement('span')
        val.className = 'jira-meta-value'
        if (avatar) {
          const img = document.createElement('img')
          img.src = avatar
          img.className = 'jira-meta-avatar'
          img.alt = value
          img.onerror = () => img.remove()
          val.append(img)
        }
        val.append(document.createTextNode(value))
        row.append(lbl, val)
        right.append(row)
      })

      // Attachments as cards (images show thumbnail)
      if (d.attachments.length) {
        const attTitle = document.createElement('div')
        attTitle.className = 'jira-detail-section-title'
        attTitle.textContent = 'Archivos adjuntos'
        const attGrid = document.createElement('div')
        attGrid.className = 'jira-att-grid'
        d.attachments.forEach(a => {
          const card = document.createElement('div')
          card.className = 'jira-att-card'
          const isImg = a.mimeType.startsWith('image/')
          const isPdf = a.mimeType === 'application/pdf'
          if (isImg) {
            const thumb = document.createElement('img')
            thumb.className = 'jira-att-thumb'
            thumb.alt = a.filename
            thumb.addEventListener('click', () => openUrl(a.content).catch(() => {}))
            const thumbUrl = a.thumbnail || a.content
            fetchAsDataUrl(thumbUrl)
              .then(data => { thumb.src = data })
              .catch(() => { thumb.replaceWith(Object.assign(document.createElement('span'), { className: 'jira-att-icon', textContent: '🖼️' })) })
            card.append(thumb)
          } else {
            const iconEl = document.createElement('span')
            iconEl.className = 'jira-att-icon'
            iconEl.textContent = isPdf ? '📄' : '📎'
            card.append(iconEl)
          }
          const name = document.createElement('span')
          name.className = 'jira-att-name'
          name.textContent = a.filename
          name.title = a.filename
          const dlBtn = document.createElement('button')
          dlBtn.className = 'jira-action'
          dlBtn.title = 'Abrir / Descargar'
          dlBtn.innerHTML = icon('arrow-right')
          dlBtn.addEventListener('click', () => openUrl(a.content).catch(() => {}))
          card.append(name, dlBtn)
          attGrid.append(card)
        })
        left.append(attTitle, attGrid)
      }

      // Transitions — move card to another status from the detail panel
      try {
        const res = await api('GET', `api/2/issue/${it.key}/transitions`) as {
          transitions?: Array<{ id: string; name: string; to: { name: string } }>
        }
        const transitions = (res?.transitions ?? []).filter(t => t.to.name !== it.status)
        if (transitions.length) {
          const trTitle = document.createElement('div')
          trTitle.className = 'jira-meta-label'
          trTitle.textContent = 'Mover a'
          const trList = document.createElement('div')
          trList.className = 'jira-transitions'
          transitions.forEach(t => {
            const btn = document.createElement('button')
            btn.className = 'jira-transition-btn'
            btn.textContent = t.to.name
            btn.addEventListener('click', async () => {
              btn.disabled = true
              btn.textContent = '…'
              try {
                await api('POST', `api/2/issue/${it.key}/transitions`, { transition: { id: t.id } })
                it.status = t.to.name
                // Refresh board if in board mode
                if (viewMode === 'board' && selectedBoardId) {
                  agileColumns = await fetchBoardColumns(selectedBoardId).catch(() => agileColumns)
                  const fresh = await fetchBoardIssues(selectedBoardId)
                  cachedIssues = fresh
                  activeAssigneeId = ''
                }
                close()
              } catch { btn.disabled = false; btn.textContent = t.to.name }
            })
            trList.append(btn)
          })
          right.append(trTitle, trList)
        }
      } catch { /* transitions not available */ }

      // Pull Requests
      if (d.pullRequests.length) {
        const prTitle = document.createElement('div')
        prTitle.className = 'jira-detail-section-title'
        prTitle.textContent = 'Pull Requests'
        const prList = document.createElement('div')
        prList.className = 'jira-detail-prs'
        d.pullRequests.forEach(pr => {
          const row = document.createElement('a')
          row.className = `jira-pr-row jira-pr-${(pr.status || 'open').toLowerCase()}`
          row.textContent = pr.title || pr.url
          row.title = pr.url
          row.addEventListener('click', () => openUrl(pr.url).catch(() => {}))
          prList.append(row)
        })
        left.append(prTitle, prList)
      }

      // ---- Editable estimation in sidebar ----
      const estRow = right.querySelector('.jira-meta-row[data-field="estimate"]') as HTMLElement | null
      const makeEstEdit = (): void => {
        const estInput = document.createElement('input')
        estInput.className = 'jira-input'
        estInput.value = d.estimate
        estInput.placeholder = '2h, 30m…'
        estInput.style.cssText = 'width:100%;margin-top:2px'
        const save = document.createElement('button')
        save.className = 'jira-primary'
        save.style.cssText = 'margin-top:4px;padding:3px 8px;font-size:11px'
        save.textContent = 'Guardar'
        save.addEventListener('click', async () => {
          save.disabled = true
          try {
            await api('PUT', `api/2/issue/${it.key}`, { update: { timetracking: [{ set: { originalEstimate: estInput.value.trim() } }] } })
            d.estimate = estInput.value.trim()
            estRow?.replaceChildren(
              Object.assign(document.createElement('span'), { className: 'jira-meta-label', textContent: 'ESTIMACIÓN' }),
              Object.assign(document.createElement('span'), { className: 'jira-meta-value' })
            )
            const valEl = estRow?.querySelector('.jira-meta-value')
            if (valEl) valEl.textContent = d.estimate
          } catch { save.disabled = false }
        })
        estRow?.append(estInput, save)
      }
      if (estRow) {
        const valEl = estRow.querySelector('.jira-meta-value')
        if (valEl) valEl.addEventListener('click', makeEstEdit)
      }

      // ---- Edit description ----
      const editDescBtn = document.createElement('button')
      editDescBtn.className = 'jira-action'
      editDescBtn.title = 'Editar descripción'
      editDescBtn.innerHTML = icon('settings')
      editDescBtn.addEventListener('click', () => {
        const ta = document.createElement('textarea')
        ta.className = 'jira-textarea'
        ta.style.cssText = 'min-height:120px;width:100%;box-sizing:border-box'
        ta.value = d.description
        const saveDesc = document.createElement('button')
        saveDesc.className = 'jira-primary'
        saveDesc.textContent = 'Guardar'
        const cancelDesc = document.createElement('button')
        cancelDesc.className = 'jira-transition-btn'
        cancelDesc.textContent = 'Cancelar'
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;gap:6px;margin-top:6px'
        row.append(saveDesc, cancelDesc)
        descEl.replaceChildren(ta, row)
        cancelDesc.addEventListener('click', () => {
          descEl.innerHTML = d.isRenderedHtml ? d.description : jiraWikiToHtml(d.description, attachMap)
        })
        saveDesc.addEventListener('click', async () => {
          saveDesc.disabled = true
          try {
            await api('PUT', `api/2/issue/${it.key}`, { fields: { description: ta.value } })
            d.description = ta.value
            d.isRenderedHtml = false
            descEl.innerHTML = jiraWikiToHtml(ta.value, attachMap)
          } catch { saveDesc.disabled = false }
        })
      })
      drawer.querySelector('.jira-header')?.append(editDescBtn)

      // ---- Comments ----
      const commentTitle = document.createElement('div')
      commentTitle.className = 'jira-detail-section-title'
      commentTitle.textContent = 'Comentarios'
      const commentList = document.createElement('div')
      commentList.className = 'jira-comment-list'
      commentList.textContent = 'Cargando comentarios…'

      const commentInput = document.createElement('textarea')
      commentInput.className = 'jira-textarea'
      commentInput.placeholder = 'Escribe un comentario…'
      commentInput.style.cssText = 'min-height:70px;width:100%;box-sizing:border-box'
      const commentSubmit = document.createElement('button')
      commentSubmit.className = 'jira-primary'
      commentSubmit.textContent = 'Comentar'
      commentSubmit.addEventListener('click', async () => {
        const text = commentInput.value.trim()
        if (!text) return
        commentSubmit.disabled = true
        try {
          await api('POST', `api/2/issue/${it.key}/comment`, { body: text })
          commentInput.value = ''
          const res = await api('GET', `api/2/issue/${it.key}/comment?maxResults=30&orderBy=-created`) as { comments?: Array<{ body: string; author?: { displayName?: string }; created?: string }> }
          renderComments(res?.comments ?? [])
        } finally { commentSubmit.disabled = false }
      })

      const renderComments = (comments: Array<{ body: string; author?: { displayName?: string }; created?: string }>): void => {
        commentList.replaceChildren()
        if (!comments.length) { commentList.textContent = 'Sin comentarios.'; return }
        comments.forEach(c => {
          const item = document.createElement('div')
          item.className = 'jira-comment'
          const cMeta = document.createElement('div')
          cMeta.className = 'jira-comment-meta'
          cMeta.textContent = `${c.author?.displayName ?? 'Anónimo'} · ${c.created ? new Date(c.created).toLocaleDateString() : ''}`
          const cBody = document.createElement('div')
          cBody.className = 'jira-comment-body jira-wiki-body'
          cBody.innerHTML = jiraWikiToHtml(c.body ?? '')
          item.append(cMeta, cBody)
          commentList.append(item)
        })
      }

      api('GET', `api/2/issue/${it.key}/comment?maxResults=30&orderBy=-created`)
        .then((res: unknown) => {
          const r = res as { comments?: Array<{ body: string; author?: { displayName?: string }; created?: string }> }
          renderComments(r?.comments ?? [])
        })
        .catch(() => { commentList.textContent = 'Error cargando comentarios.' })

      left.append(commentTitle, commentList, commentInput, commentSubmit)
    }).catch(() => { descEl.textContent = '(error cargando descripción)' })
    overlay.append(drawer)
    md.detail.append(overlay)
  }

  // ---- create ----
  const showCreate = (): void => {
    const project = field('Proyecto (clave, ej. BEN)')
    const type = field('Tipo', 'Task')
    const summary = field('Resumen')
    const assignee = field('Asignar a (email, opcional)', activeAccount?.email ?? '')
    const descLabel = document.createElement('label')
    descLabel.className = 'jira-field'
    descLabel.textContent = i18nT('jira.description')
    const desc = document.createElement('textarea')
    desc.className = 'jira-textarea'
    descLabel.appendChild(desc)
    const create = document.createElement('button')
    create.className = 'jira-primary'
    create.textContent = i18nT('jira.createIssue')
    const status = note('')
    create.addEventListener('click', async () => {
      const p = project.input.value.trim()
      const s = summary.input.value.trim()
      if (!p || !s) { status.textContent = i18nT('jira.projectAndSummaryAreRequired'); return }
      status.textContent = i18nT('common.creating')
      try {
        const email = assignee.input.value.trim()
        const accountId = email ? await resolveAccountId(email).catch(() => null) : null
        if (email && !accountId) { status.textContent = i18nT('jira.userNotFound', { email }); return }
        const res = await createIssue(p, type.input.value.trim() || 'Task', s, desc.value, accountId ?? undefined) as { key?: string }
        status.textContent = i18nT('jira.created', { key: res?.key ?? 'ok' })
      } catch (e) {
        status.textContent = String(e)
      }
    })
    const bulkLink = document.createElement('a')
    bulkLink.className = 'jira-hint-link'
    bulkLink.textContent = 'Importar varias →'
    bulkLink.addEventListener('click', () => showBulk())
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(project.row, type.row, summary.row, assignee.row, descLabel, create, bulkLink, status)
    showDetail(detailHeader('Nueva tarjeta', mkBtn('arrow-left', 'Volver', () => showIssues())), body)
  }

  // ---- bulk import ----
  const showBulk = (): void => {
    const project = field('Proyecto (clave, ej. KAN)')
    const type = field('Tipo', 'Task')
    const assignee = field('Asignar a (email, opcional)', activeAccount?.email ?? '')
    const taLabel = document.createElement('label')
    taLabel.className = 'jira-field'
    taLabel.textContent = i18nT('jira.oneIssuePerLineFormatSummaryDescription')
    const ta = document.createElement('textarea')
    ta.className = 'jira-textarea'
    ta.placeholder = i18nT('common.dockerPanelManageContainersSqlRunnerRunCustom')
    taLabel.appendChild(ta)
    const status = note('')
    const create = document.createElement('button')
    create.className = 'jira-primary'
    create.textContent = i18nT('jira.createAll')
    create.addEventListener('click', async () => {
      const p = project.input.value.trim()
      const t = type.input.value.trim() || 'Task'
      const issues = parseBulkIssues(ta.value)
      if (!p || !issues.length) { status.textContent = i18nT('jira.projectAndAtLeastOneLineAreRequired'); return }
      let accountId: string | null = null
      const email = assignee.input.value.trim()
      if (email) {
        status.textContent = i18nT('jira.resolvingAssignee')
        accountId = await resolveAccountId(email).catch(() => null)
        if (!accountId) { status.textContent = i18nT('jira.userNotFound', { email }); return }
      }
      let ok = 0
      const errors: string[] = []
      for (const it of issues) {
        status.textContent = i18nT('jira.creatingProgress', { current: ok + errors.length + 1, total: issues.length })
        try { await createIssue(p, t, it.summary, it.description, accountId ?? undefined); ok++ }
        catch (e) { errors.push(`${it.summary}: ${String(e).slice(0, 80)}`) }
      }
      status.textContent = i18nT('jira.createdSummary', { created: ok, total: issues.length, errors: errors.length ? i18nT('jira.errors', { errors: errors.join(' · ') }) : '' })
    })
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(project.row, type.row, assignee.row, taLabel, create, status)
    showDetail(detailHeader('Importar tarjetas', mkBtn('arrow-left', 'Volver', () => showCreate())), body)
  }

  // ---- boot ----
  loadAccounts().then(() => {
    if (accounts.length === 1) {
      activeAccount = accounts[0]
      md.select(accounts[0].id)
      showIssues()
    }
  })

  return { element: md.element }
}

function note(text: string, cls = 'jira-note'): HTMLElement {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = text
  return el
}

function mkBtn(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'jira-action'
  b.title = title
  b.innerHTML = icon(iconName)
  b.addEventListener('click', onClick)
  return b
}
