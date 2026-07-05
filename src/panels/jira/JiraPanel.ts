import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { basicAuth } from '../../core/jira/auth'
import { apiUrl, browseUrl } from '../../core/jira/urls'
import { parseIssues, type JiraIssue } from '../../core/jira/issues'
import { parseBulkIssues } from '../../core/jira/bulk'
import { MY_OPEN_ISSUES } from '../../core/jira/jql'
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
    headerActions: [addBtn],
    onSelect: id => {
      activeAccount = accounts.find(a => a.id === id) ?? null
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

  const fetchDescription = async (key: string): Promise<string> => {
    const json = await api('GET', `api/2/issue/${key}?fields=description`) as { fields?: { description?: string } }
    return json?.fields?.description ?? ''
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

  // ---- issue list ----
  const statusClass = (cat: string): string =>
    cat === 'done' ? 'jira-st-done' : cat === 'indeterminate' ? 'jira-st-progress' : 'jira-st-todo'

  const showIssues = (jql = MY_OPEN_ISSUES): void => {
    if (!activeAccount) return
    const search = document.createElement('input')
    search.className = 'jira-search'
    search.value = jql
    search.placeholder = i18nT('jira.jqlPlaceholder')
    const list = document.createElement('div')
    list.className = 'jira-list'

    const load = async (q: string): Promise<void> => {
      list.replaceChildren(note(i18nT('common.loading')))
      try {
        const issues = await searchIssues(q)
        list.replaceChildren()
        if (!issues.length) { list.append(note(i18nT('jira.noResults'))); return }
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
      } catch (e) {
        list.replaceChildren(note(String(e), 'jira-error'))
      }
    }

    search.addEventListener('keydown', e => { if (e.key === 'Enter') load(search.value) })
    showDetail(
      detailHeader(
        activeAccount.id,
        mkBtn('plus', 'Nueva tarjeta', () => showCreate()),
        mkBtn('refresh', 'Recargar', () => load(search.value)),
        mkBtn('settings', 'Editar cuenta', () => showConfig(activeAccount!)),
      ),
      search,
      list,
    )
    load(jql)
  }

  // ---- issue detail ----
  const showIssueDetail = async (it: JiraIssue): Promise<void> => {
    const openBtn = mkBtn('globe', 'Abrir en Jira', () => openUrl(browseUrl(activeAccount!.site, it.key)).catch(() => {}))
    const backBtn = mkBtn('arrow-left', 'Volver', () => showIssues())
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
    const desc = document.createElement('pre')
    desc.className = 'jira-detail-desc'
    desc.textContent = 'Cargando descripción…'
    fetchDescription(it.key).then(d => { desc.textContent = d || '(sin descripción)' }).catch(() => { desc.textContent = '' })
    const body = document.createElement('div')
    body.className = 'jira-detail'
    body.append(meta, summary, desc)
    showDetail(detailHeader('Detalle', openBtn, backBtn), body)
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
