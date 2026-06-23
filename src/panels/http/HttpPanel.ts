import { invoke } from '@tauri-apps/api/core'
import { parseHeaders, prettyBody, addHeaderLine, urlParams } from '../../core/http/httpRequest'
import { parseOpenApi, specTitle, type OpenApiEndpoint } from '../../core/http/openapi'
import { addCollection, removeCollection, renameCollection, type Collection } from '../../core/http/collections'
import { showContextMenu } from '../../ui/contextMenu'
import { icon } from '../../ui/icons'

const COMMON_HEADERS = [
  'Content-Type: application/json',
  'Accept: application/json',
  'Authorization: Bearer ',
  'Content-Type: application/x-www-form-urlencoded',
  'X-Requested-With: XMLHttpRequest',
]

const BODY_TEMPLATES: { label: string; header?: string; body: string }[] = [
  { label: 'JSON', header: 'Content-Type: application/json', body: '{\n  "": ""\n}' },
  { label: 'Form urlencoded', header: 'Content-Type: application/x-www-form-urlencoded', body: 'campo=valor&otro=valor' },
  { label: 'Texto vacío', body: '' },
]

interface HttpResponse {
  status: number
  status_text: string
  headers: [string, string][]
  body: string
}

interface SavedRequest { method: string; url: string; headers: string; body: string }

const STATE_KEY = (id: string) => `bento.http.${id}`
const COLLECTIONS_KEY = 'bento.http.collections' // shared API library across panels
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const loadCollections = (): Collection[] => {
  try { return JSON.parse(localStorage.getItem(COLLECTIONS_KEY) ?? '[]') } catch { return [] }
}
const saveCollections = (list: Collection[]): void => {
  try { localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(list)) } catch { /* lleno */ }
}

let httpCounter = 0

export function createHttpPanel(panelId = '') {
  const id = panelId || `http-${++httpCounter}`
  const root = document.createElement('div')
  root.className = 'http-panel'

  const bar = document.createElement('div')
  bar.className = 'http-bar'
  const method = document.createElement('select')
  method.className = 'http-method'
  METHODS.forEach(m => {
    const opt = document.createElement('option')
    opt.value = m
    opt.textContent = m
    method.appendChild(opt)
  })
  const url = document.createElement('input')
  url.className = 'http-url'
  url.placeholder = 'https://api.example.com/…'
  url.spellcheck = false
  const importBtn = document.createElement('button')
  importBtn.className = 'http-import'
  importBtn.textContent = 'Importar OpenAPI'
  importBtn.title = 'Pon la URL de un swagger.json / openapi.json y pulsa aquí'
  const sendBtn = document.createElement('button')
  sendBtn.className = 'http-send'
  sendBtn.textContent = 'Enviar'
  bar.append(method, url, importBtn, sendBtn)

  const reqHeaders = document.createElement('textarea')
  reqHeaders.className = 'http-area'
  reqHeaders.placeholder = 'Cabeceras — una por línea:\nContent-Type: application/json'
  reqHeaders.spellcheck = false
  const reqBody = document.createElement('textarea')
  reqBody.className = 'http-area'
  reqBody.placeholder = 'Cuerpo de la petición (JSON, texto…)'
  reqBody.spellcheck = false

  const headersField = labeled('Cabeceras', reqHeaders, [
    action('+ común', el => showContextMenu(rectLeft(el), rectBottom(el),
      COMMON_HEADERS.map(h => ({ label: h, onClick: () => { reqHeaders.value = addHeaderLine(reqHeaders.value, h); save() } })))),
  ])
  const bodyField = labeled('Body', reqBody, [
    action('plantilla', el => showContextMenu(rectLeft(el), rectBottom(el),
      BODY_TEMPLATES.map(t => ({ label: t.label, onClick: () => {
        reqBody.value = t.body
        if (t.header) reqHeaders.value = addHeaderLine(reqHeaders.value, t.header)
        save()
      } })))),
    action('formato', () => { reqBody.value = prettyBody(reqBody.value); save() }),
  ])

  const reqSection = document.createElement('div')
  reqSection.className = 'http-req'
  reqSection.append(headersField, bodyField)

  const status = document.createElement('div')
  status.className = 'http-status'
  const response = document.createElement('pre')
  response.className = 'http-response'
  const resSection = document.createElement('div')
  resSection.className = 'http-res'
  resSection.append(status, response)

  // Draggable divider: give more height to the request (big body) or the response.
  const divider = document.createElement('div')
  divider.className = 'http-divider'
  let dragging = false
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return
    const top = reqSection.getBoundingClientRect().top
    reqSection.style.height = `${Math.max(80, e.clientY - top)}px`
  }
  const onUp = (): void => { dragging = false }
  divider.addEventListener('mousedown', e => { dragging = true; e.preventDefault() })
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)

  const sidebar = document.createElement('div')
  sidebar.className = 'http-sidebar hidden'
  const search = document.createElement('input')
  search.className = 'http-col-search'
  search.placeholder = 'Buscar endpoint…'
  search.spellcheck = false
  const colList = document.createElement('div')
  colList.className = 'http-col-list'
  sidebar.append(search, colList)
  const main = document.createElement('div')
  main.className = 'http-main'
  main.append(bar, reqSection, divider, resSection)
  root.append(sidebar, main)

  const fields = [url, reqHeaders, reqBody]
  fields.forEach(el => el.addEventListener('keydown', e => e.stopPropagation()))

  const saved = readState()
  if (saved) {
    method.value = saved.method
    url.value = saved.url
    reqHeaders.value = saved.headers
    reqBody.value = saved.body
  }

  function readState(): SavedRequest | null {
    try { return JSON.parse(localStorage.getItem(STATE_KEY(id)) ?? '') } catch { return null }
  }
  // Collections (imported APIs) are a shared library across all HTTP panels.
  let collections = loadCollections()

  const save = (): void => {
    const state: SavedRequest = { method: method.value, url: url.value, headers: reqHeaders.value, body: reqBody.value }
    try { localStorage.setItem(STATE_KEY(id), JSON.stringify(state)) } catch { /* lleno */ }
  }
  ;[method, url, reqHeaders, reqBody].forEach(el => el.addEventListener('change', save))

  const fillFromEndpoint = (e: OpenApiEndpoint): void => {
    method.value = e.method
    url.value = e.url
    reqBody.value = e.body
    reqHeaders.value = e.headers
    if (e.body) reqHeaders.value = addHeaderLine(reqHeaders.value, 'Content-Type: application/json')
    save()
  }

  const COLLAPSED_KEY = 'bento.http.collapsed'
  const collapsed = new Set<string>(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'))
  const saveCollapsed = (): void => localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))

  const renderCollections = (): void => {
    colList.innerHTML = ''
    sidebar.classList.toggle('hidden', collections.length === 0)
    const q = search.value.trim().toLowerCase()
    const matches = (e: OpenApiEndpoint): boolean => !q || `${e.method} ${e.url} ${e.summary}`.toLowerCase().includes(q)

    collections.forEach(c => {
      const eps = c.endpoints.filter(matches)
      if (q && eps.length === 0) return
      // A search forces every matching collection open; otherwise respect the toggle.
      const open = q ? true : !collapsed.has(c.id)

      const header = document.createElement('div')
      header.className = 'http-col-header'
      const chevron = document.createElement('span')
      chevron.className = `http-col-chevron${open ? ' open' : ''}`
      chevron.innerHTML = icon('chevron')
      const name = document.createElement('span')
      name.className = 'http-col-name'
      name.textContent = `${c.name} (${c.endpoints.length})`
      name.title = 'Doble clic para renombrar'
      name.addEventListener('dblclick', e => {
        e.stopPropagation()
        const input = document.createElement('input')
        input.className = 'http-col-rename'
        input.value = c.name
        name.replaceWith(input)
        input.focus()
        input.select()
        input.addEventListener('click', ev => ev.stopPropagation())
        const commit = (): void => {
          const next = input.value.trim() || c.name
          collections = renameCollection(collections, c.id, next)
          saveCollections(collections)
          renderCollections()
        }
        input.addEventListener('keydown', ev => {
          ev.stopPropagation()
          if (ev.key === 'Enter') input.blur()
          if (ev.key === 'Escape') { input.value = c.name; input.blur() }
        })
        input.addEventListener('blur', commit)
      })
      const del = document.createElement('span')
      del.className = 'http-col-del'
      del.innerHTML = icon('x')
      del.title = 'Quitar colección'
      del.addEventListener('click', e => { e.stopPropagation(); collections = removeCollection(collections, c.id); saveCollections(collections); renderCollections() })
      header.append(chevron, name, del)
      header.addEventListener('click', () => {
        if (collapsed.has(c.id)) collapsed.delete(c.id); else collapsed.add(c.id)
        saveCollapsed()
        renderCollections()
      })
      colList.appendChild(header)

      if (!open) return
      eps.forEach(e => {
        const item = document.createElement('button')
        item.className = 'http-ep'
        item.title = `${e.method} ${e.url}`
        item.innerHTML = `<span class="http-ep-method ${e.method.toLowerCase()}">${e.method}</span><span class="http-ep-name">${e.summary || e.url}</span>`
        item.addEventListener('click', () => fillFromEndpoint(e))
        colList.appendChild(item)
      })
    })
  }
  renderCollections()
  search.addEventListener('input', renderCollections)
  search.addEventListener('keydown', e => e.stopPropagation())

  const importSpec = (): void => {
    const specUrl = url.value.trim()
    if (!specUrl) return
    importBtn.textContent = '…'
    invoke<string>('http_get', { url: specUrl })
      .then(text => {
        const spec = JSON.parse(text)
        const collection: Collection = { id: `col-${Date.now().toString(36)}`, name: specTitle(spec), endpoints: parseOpenApi(spec, specUrl) }
        collections = addCollection(collections, collection)
        saveCollections(collections)
        renderCollections()
      })
      .catch(err => {
        status.className = 'http-status err'
        status.textContent = `No se pudo importar: ${err}`
      })
      .finally(() => { importBtn.textContent = 'Importar OpenAPI' })
  }
  importBtn.addEventListener('click', importSpec)

  const send = (): void => {
    if (!url.value.trim()) return
    const missing = urlParams(url.value)
    if (missing.length) {
      status.className = 'http-status warn'
      status.textContent = `Rellena los parámetros de la URL: ${missing.map(p => `{${p}}`).join(', ')}`
      return
    }
    save()
    status.textContent = '…'
    status.className = 'http-status'
    response.textContent = ''
    invoke<HttpResponse>('http_request', {
      method: method.value,
      url: url.value.trim(),
      headers: parseHeaders(reqHeaders.value),
      body: reqBody.value || null,
    })
      .then(res => {
        const cls = res.status >= 500 ? 'err' : res.status >= 400 ? 'warn' : 'ok'
        status.className = `http-status ${cls}`
        status.textContent = `${res.status} ${res.status_text}`
        response.textContent = prettyBody(res.body)
      })
      .catch(err => {
        status.className = 'http-status err'
        status.textContent = 'Error'
        response.textContent = String(err)
      })
  }

  sendBtn.addEventListener('click', send)
  url.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send() } })

  return {
    element: root,
    fit: () => {},
    focus: () => url.focus(),
    dispose: () => {
      save()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    },
  }
}

function labeled(label: string, el: HTMLElement, actions: HTMLElement[] = []): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'http-field'
  const row = document.createElement('div')
  row.className = 'http-label-row'
  const txt = document.createElement('span')
  txt.className = 'http-label'
  txt.textContent = label
  row.append(txt, ...actions)
  wrap.append(row, el)
  return wrap
}

function action(text: string, onClick: (el: HTMLElement) => void): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'http-action'
  btn.textContent = text
  btn.addEventListener('click', () => onClick(btn))
  return btn
}

const rectLeft = (el: HTMLElement): number => el.getBoundingClientRect().left
const rectBottom = (el: HTMLElement): number => el.getBoundingClientRect().bottom
