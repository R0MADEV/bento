import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { basicAuth } from '../../core/jira/auth'
import { apiUrl, browseUrl } from '../../core/jira/urls'
import { parseIssues, type JiraIssue } from '../../core/jira/issues'
import { parseBulkIssues } from '../../core/jira/bulk'
import { MY_OPEN_ISSUES } from '../../core/jira/jql'
import { icon } from '../../ui/icons'

interface JiraConfig { site: string; email: string; token: string }
interface HttpResponse { status: number; body: string }

const isConfigured = (c: JiraConfig): boolean => !!(c.site && c.email && c.token)

export function createJiraPanel(): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'jira-panel'
  let cfg: JiraConfig = { site: '', email: '', token: '' }

  // ---- API (reuses the existing http_request Rust command) ----
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await invoke<HttpResponse>('http_request', {
      method,
      url: apiUrl(cfg.site, path),
      headers: [
        ['Authorization', basicAuth(cfg.email, cfg.token)],
        ['Accept', 'application/json'],
        ['Content-Type', 'application/json'],
      ],
      body: body !== undefined ? JSON.stringify(body) : null,
    })
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} — ${res.body.slice(0, 300)}`)
    }
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

  // Jira assigns by accountId, not email (privacy). Resolve an email → accountId.
  const resolveAccountId = async (email: string): Promise<string | null> => {
    if (!email) return null
    const users = await api('GET', `api/2/user/search?query=${encodeURIComponent(email)}`) as Array<{ accountId?: string }>
    return Array.isArray(users) && users[0]?.accountId ? users[0].accountId : null
  }

  // ---- views ----
  const show = (...nodes: HTMLElement[]): void => root.replaceChildren(...nodes)

  const header = (title: string, ...actions: HTMLElement[]): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = 'jira-header'
    const h = document.createElement('span')
    h.className = 'jira-title'
    h.textContent = title
    bar.append(h, ...actions)
    return bar
  }

  const iconBtn = (name: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'jira-action'
    b.title = title
    b.innerHTML = icon(name)
    b.addEventListener('click', onClick)
    return b
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

  const renderConfig = (): void => {
    const site = field('Site (https://tuorg.atlassian.net)', cfg.site)
    const email = field('Email', cfg.email)
    const token = field('API token', cfg.token, 'password')
    const hint = document.createElement('a')
    hint.className = 'jira-hint-link'
    hint.textContent = 'Generar API token →'
    hint.addEventListener('click', () => openUrl('https://id.atlassian.com/manage-profile/security/api-tokens').catch(() => {}))
    const save = document.createElement('button')
    save.className = 'jira-primary'
    save.textContent = 'Conectar'
    save.addEventListener('click', async () => {
      const next = { site: site.input.value.trim(), email: email.input.value.trim(), token: token.input.value.trim() }
      if (!isConfigured(next)) return
      await invoke('jira_config_set', next).catch(() => {})
      cfg = next
      renderList()
    })
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(site.row, email.row, token.row, hint, save)
    show(header('Conectar Jira'), body)
  }

  const statusClass = (cat: string): string =>
    cat === 'done' ? 'jira-st-done' : cat === 'indeterminate' ? 'jira-st-progress' : 'jira-st-todo'

  const renderList = async (jql = MY_OPEN_ISSUES): Promise<void> => {
    const search = document.createElement('input')
    search.className = 'jira-search'
    search.value = jql
    search.placeholder = 'JQL…'
    const list = document.createElement('div')
    list.className = 'jira-list'

    const load = async (q: string): Promise<void> => {
      list.replaceChildren(note('Cargando…'))
      try {
        const issues = await searchIssues(q)
        list.replaceChildren()
        if (!issues.length) { list.append(note('Sin resultados.')); return }
        issues.forEach(it => {
          const row = document.createElement('button')
          row.className = 'jira-issue'
          row.innerHTML =
            `<span class="jira-key">${it.key}</span>` +
            `<span class="jira-summary"></span>` +
            `<span class="jira-status ${statusClass(it.statusCategory)}">${it.status}</span>`
          row.querySelector('.jira-summary')!.textContent = it.summary
          row.addEventListener('click', () => renderDetail(it))
          list.appendChild(row)
        })
      } catch (e) {
        list.replaceChildren(note(String(e), 'jira-error'))
      }
    }

    search.addEventListener('keydown', e => { if (e.key === 'Enter') load(search.value) })
    show(
      header('Jira',
        iconBtn('plus', 'Nueva tarjeta', () => renderCreate()),
        iconBtn('refresh', 'Recargar', () => load(search.value)),
        iconBtn('settings', 'Conexión', () => renderConfig()),
      ),
      search,
      list,
    )
    load(jql)
  }

  const renderDetail = async (it: JiraIssue): Promise<void> => {
    const back = iconBtn('arrow-left', 'Volver', () => renderList())
    const openBtn = iconBtn('globe', 'Abrir en Jira', () => openUrl(browseUrl(cfg.site, it.key)).catch(() => {}))
    const meta = document.createElement('div')
    meta.className = 'jira-detail-meta'
    meta.innerHTML =
      `<span class="jira-key">${it.key}</span>` +
      `<span class="jira-status ${statusClass(it.statusCategory)}">${it.status}</span>` +
      `<span class="jira-type">${it.type}</span>`
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
    show(header('Detalle', openBtn, back), body)
  }

  const renderCreate = (): void => {
    const back = iconBtn('arrow-left', 'Volver', () => renderList())
    const project = field('Proyecto (clave, ej. BEN)')
    const type = field('Tipo', 'Task')
    const summary = field('Resumen')
    const descLabel = document.createElement('label')
    descLabel.className = 'jira-field'
    descLabel.textContent = 'Descripción'
    const desc = document.createElement('textarea')
    desc.className = 'jira-textarea'
    descLabel.appendChild(desc)
    const create = document.createElement('button')
    create.className = 'jira-primary'
    create.textContent = 'Crear tarjeta'
    const status = note('')
    create.addEventListener('click', async () => {
      const p = project.input.value.trim()
      const s = summary.input.value.trim()
      if (!p || !s) { status.textContent = 'Proyecto y resumen son obligatorios.'; return }
      status.textContent = 'Creando…'
      try {
        const res = await createIssue(p, type.input.value.trim() || 'Task', s, desc.value) as { key?: string }
        status.textContent = `Creada: ${res?.key ?? 'ok'}`
      } catch (e) {
        status.textContent = String(e)
      }
    })
    const bulkLink = document.createElement('a')
    bulkLink.className = 'jira-hint-link'
    bulkLink.textContent = 'Importar varias →'
    bulkLink.addEventListener('click', () => renderBulk())
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(project.row, type.row, summary.row, descLabel, create, bulkLink, status)
    show(header('Nueva tarjeta', back), body)
  }

  const renderBulk = (): void => {
    const back = iconBtn('arrow-left', 'Volver', () => renderCreate())
    const project = field('Proyecto (clave, ej. KAN)')
    const type = field('Tipo', 'Task')
    const assignee = field('Asignar a (email, opcional)', cfg.email)
    const taLabel = document.createElement('label')
    taLabel.className = 'jira-field'
    taLabel.textContent = 'Una tarjeta por línea — formato: resumen | descripción'
    const ta = document.createElement('textarea')
    ta.className = 'jira-textarea'
    ta.placeholder = 'Panel Docker | gestionar contenedores\nSQL runner | ejecutar queries propias'
    taLabel.appendChild(ta)
    const status = note('')
    const create = document.createElement('button')
    create.className = 'jira-primary'
    create.textContent = 'Crear todas'
    create.addEventListener('click', async () => {
      const p = project.input.value.trim()
      const t = type.input.value.trim() || 'Task'
      const issues = parseBulkIssues(ta.value)
      if (!p || !issues.length) { status.textContent = 'Proyecto y al menos una línea son obligatorios.'; return }
      let accountId: string | null = null
      const email = assignee.input.value.trim()
      if (email) {
        status.textContent = 'Resolviendo asignado…'
        accountId = await resolveAccountId(email).catch(() => null)
        if (!accountId) { status.textContent = `No se encontró el usuario "${email}" en Jira.`; return }
      }
      let ok = 0
      const errors: string[] = []
      for (const it of issues) {
        status.textContent = `Creando ${ok + errors.length + 1}/${issues.length}…`
        try { await createIssue(p, t, it.summary, it.description, accountId ?? undefined); ok++ }
        catch (e) { errors.push(`${it.summary}: ${String(e).slice(0, 80)}`) }
      }
      status.textContent = `Creadas ${ok}/${issues.length}.${errors.length ? ' Errores: ' + errors.join(' · ') : ''}`
    })
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(project.row, type.row, assignee.row, taLabel, create, status)
    show(header('Importar tarjetas', back), body)
  }

  // ---- boot ----
  invoke<JiraConfig>('jira_config_get')
    .then(c => { cfg = c; if (isConfigured(c)) renderList(); else renderConfig() })
    .catch(() => renderConfig())

  return { element: root }
}

function note(text: string, cls = 'jira-note'): HTMLElement {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = text
  return el
}
