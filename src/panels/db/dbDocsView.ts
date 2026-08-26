import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { icon } from '../../ui/helpers/icons'
import { creds, target } from '../../core/db/dbEngine'
import { prettyJson } from './dbCellRender'
import { note, makeFilterInput } from './dbWidgets'
import type { DbDetailHost } from './dbDetailHost'

export const DOCS_PAGE = 20

const editDoc = (s: DbServer, db: string, coll: string, pre: HTMLElement): void => {
  const original = pre.textContent ?? ''
  const ta = document.createElement('textarea')
  ta.className = 'db-doc-edit'
  ta.value = original
  const actions = document.createElement('div')
  actions.className = 'db-doc-actions'
  const save = document.createElement('button')
  save.className = 'db-connect'
  save.textContent = i18nT('common.save')
  const cancel = document.createElement('button')
  cancel.className = 'db-doc-cancel'
  cancel.textContent = i18nT('common.cancel')
  actions.append(save, cancel)
  const wrap = document.createElement('div')
  wrap.className = 'db-doc-wrap'
  wrap.append(ta, actions)
  pre.replaceWith(wrap)
  ta.focus()
  const restore = (text: string): void => { wrap.replaceWith(makeDocPre(s, db, coll, text)) }
  cancel.addEventListener('click', () => restore(original))
  save.addEventListener('click', async () => {
    if (!confirm(i18nT('db.replaceTheDocumentById'))) return
    try {
      await invoke('db_docker_mongo_update', { ...target(s), db, collection: coll, doc: ta.value, ...creds(s) })
      restore(prettyJson(ta.value))
    } catch (e) {
      alert(String(e))
    }
  })
}

const makeDocPre = (s: DbServer, db: string, coll: string, text: string): HTMLPreElement => {
  const pre = document.createElement('pre')
  pre.className = 'db-doc'
  pre.textContent = text
  pre.addEventListener('dblclick', () => editDoc(s, db, coll, pre))
  return pre
}

const deleteDoc = async (s: DbServer, db: string, coll: string, item: HTMLElement, current: string): Promise<void> => {
  if (!confirm(i18nT('db.deleteThisDocument'))) return
  try {
    await invoke('db_docker_mongo_delete', { ...target(s), db, collection: coll, doc: current, ...creds(s) })
    item.remove()
  } catch (e) {
    alert(String(e))
  }
}

export const renderDocs = (host: DbDetailHost, s: DbServer, db: string, coll: string, docs: string[]): void => {
  const { showDetail, detailHead } = host
  const scroll = document.createElement('div')
  scroll.className = 'db-docs'

  const addNewDocRow = (): void => {
    scroll.querySelector('.db-new-doc-wrap')?.remove()
    const ta = document.createElement('textarea'); ta.className = 'db-doc-edit'; ta.value = '{\n  \n}'
    const acts = document.createElement('div'); acts.className = 'db-doc-actions'
    const saveBtn = document.createElement('button'); saveBtn.className = 'db-connect'; saveBtn.textContent = i18nT('common.save')
    const cancelBtn = document.createElement('button'); cancelBtn.className = 'db-doc-cancel'; cancelBtn.textContent = i18nT('common.cancel')
    acts.append(saveBtn, cancelBtn)
    const wrap = document.createElement('div'); wrap.className = 'db-doc-wrap db-new-doc-wrap'; wrap.append(ta, acts)
    scroll.prepend(wrap); ta.focus()
    cancelBtn.addEventListener('click', () => wrap.remove())
    saveBtn.addEventListener('click', async () => {
      try {
        const esc = (v: string): string => v.replace(/'/g, "\\'")
        await invoke<string>('db_docker_mongo_query', { ...target(s), db, script: `db.getSiblingDB('${esc(db)}').getCollection('${esc(coll)}').insertOne(${ta.value})`, ...creds(s) })
        wrap.remove()
        const fresh = await invoke<string[]>('db_docker_mongo_docs', { ...target(s), db, collection: coll, ...creds(s) })
        renderDocs(host, s, db, coll, fresh)
      } catch (e) { alert(String(e)) }
    })
  }

  const items: Array<{ el: HTMLElement; text: string }> = []
  let docsShown = 0

  const addDocBatch = (): void => {
    scroll.querySelector('.db-load-more')?.remove()
    docs.slice(docsShown, docsShown + DOCS_PAGE).forEach(d => {
      const item = document.createElement('div'); item.className = 'db-doc-item'
      const del = document.createElement('button'); del.className = 'db-del db-doc-del'
      del.title = i18nT('db.deleteDocument'); del.innerHTML = icon('trash')
      del.addEventListener('click', () => deleteDoc(s, db, coll, item, item.querySelector('.db-doc')?.textContent ?? prettyJson(d)))
      const pre = makeDocPre(s, db, coll, prettyJson(d))
      item.append(del, pre); scroll.appendChild(item)
      items.push({ el: item, text: prettyJson(d).toLowerCase() })
    })
    docsShown += DOCS_PAGE
    if (docsShown < docs.length) {
      const btn = document.createElement('button'); btn.className = 'db-load-more'
      btn.textContent = i18nT('db.loadMore'); btn.addEventListener('click', addDocBatch)
      scroll.appendChild(btn)
    }
  }

  if (!docs.length) scroll.append(note(i18nT('db.noDocuments')))
  else addDocBatch()

  const addBtn = document.createElement('button'); addBtn.className = 'db-action'; addBtn.title = i18nT('db.newDoc'); addBtn.innerHTML = icon('plus')
  addBtn.addEventListener('click', addNewDocRow)
  const filterInput = makeFilterInput(q => {
    items.forEach(({ el, text }) => { el.style.display = !q || text.includes(q) ? '' : 'none' })
  })
  filterInput.placeholder = i18nT('db.filterDocs')
  const toolbar = document.createElement('div'); toolbar.className = 'db-result-toolbar'
  toolbar.append(addBtn, filterInput)
  showDetail(detailHead(`${db}.${coll}`, i18nT('db.documentsSummary', { name: docs.length })), toolbar, scroll)
}
