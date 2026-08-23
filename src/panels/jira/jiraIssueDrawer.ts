import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/icons'
import { browseUrl } from '../../core/jira/urls'
import { jiraWikiToHtml } from '../../core/jira/wikiMarkup'
import { statusCategoryClass, type AgileColumn } from '../../core/jira/board'
import type { JiraIssue } from '../../core/jira/issues'
import { mkBtn, detailHeader } from './jiraWidgets'
import type { JiraAccount, JiraClient } from './jiraClient'

export interface JiraIssueDrawerDeps {
  jira: JiraClient
  getActiveAccount: () => JiraAccount | null
  detailPane: HTMLElement
  getViewMode: () => 'list' | 'board'
  getSelectedBoardId: () => number | null
  getAgileColumns: () => AgileColumn[]
  setAgileColumns: (cols: AgileColumn[]) => void
  getCachedIssues: () => JiraIssue[]
  setCachedIssues: (issues: JiraIssue[]) => void
  /** Board mode filters by assignee; a background refresh must not keep a stale one. */
  resetAssigneeFilter: () => void
}

/** The issue detail drawer: shown over the board/list, its state preserved underneath. */
  export async function showIssueDetail(deps: JiraIssueDrawerDeps, it: JiraIssue): Promise<void> {
  const { jira, getActiveAccount, detailPane, getViewMode, getSelectedBoardId, getAgileColumns, setAgileColumns, setCachedIssues, resetAssigneeFilter } = deps
  const api = jira.request
    const close = (): void => { overlay.remove() }

    const overlay = document.createElement('div')
    overlay.className = 'jira-drawer-overlay'
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })

    const drawer = document.createElement('div')
    drawer.className = 'jira-drawer'

    const openBtn = mkBtn('globe', 'Abrir en Jira', () => openUrl(browseUrl(getActiveAccount()!.site, it.key)).catch(() => {}))
    const closeBtn = mkBtn('x', 'Cerrar', close)

    const meta = document.createElement('div')
    meta.className = 'jira-detail-meta'
    const key = document.createElement('span')
    key.className = 'jira-key'
    key.textContent = it.key
    const status = document.createElement('span')
    status.className = `jira-status ${statusCategoryClass(it.statusCategory)}`
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

    jira.fetchIssueDetail(it.key).then(async d => {
      // Render description: use Jira's pre-rendered HTML if available, else parse wiki markup
      const attachMap = new Map(d.attachments.map(a => [a.filename, a.content]))
      if (d.isRenderedHtml) {
        descEl.innerHTML = d.description || '<em>(sin descripción)</em>'
        // Replace image srcs with authenticated data URLs
        descEl.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('src')
          if (src) jira.fetchAsDataUrl(src).then(data => { img.src = data }).catch(() => {})
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
            jira.fetchAsDataUrl(thumbUrl)
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
                if (getViewMode() === 'board' && getSelectedBoardId()) {
                  const boardId = getSelectedBoardId()!
                  const cols = await jira.fetchBoardColumns(boardId).catch(() => getAgileColumns())
                  setAgileColumns(cols)
                  setCachedIssues(await jira.fetchBoardIssues(boardId))
                  resetAssigneeFilter()
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
    detailPane.append(overlay)
  }

  // ---- create ----
