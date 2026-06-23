import { invoke } from '@tauri-apps/api/core'
import { parseHeaders, prettyBody, addHeaderLine } from '../../core/http/httpRequest'
import { showContextMenu } from '../../ui/contextMenu'

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
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

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
  const sendBtn = document.createElement('button')
  sendBtn.className = 'http-send'
  sendBtn.textContent = 'Enviar'
  bar.append(method, url, sendBtn)

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

  root.append(bar, reqSection, resSection)

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
  const save = (): void => {
    const state: SavedRequest = { method: method.value, url: url.value, headers: reqHeaders.value, body: reqBody.value }
    try { localStorage.setItem(STATE_KEY(id), JSON.stringify(state)) } catch { /* lleno */ }
  }
  ;[method, url, reqHeaders, reqBody].forEach(el => el.addEventListener('change', save))

  const send = (): void => {
    if (!url.value.trim()) return
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
    dispose: () => save(),
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
