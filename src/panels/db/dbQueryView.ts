import { t as i18nT } from '../../i18n'
import type { DbServer } from '../../core/db/dbServer'
import type { ForeignKey } from './queryBuilders'
import { KIND_LABEL, isMongo, isRedis } from '../../core/db/dbEngine'
import { fetchColumns, fetchRelations } from './dbAccess'
import { note } from './dbWidgets'
import type { DbDetailHost } from './dbDetailHost'
import { createQueryHistory } from './dbQueryHistory'
import { createQueryRunner } from './dbQueryExec'
import { createAiQueryButton } from './dbQueryAi'
import { createJoinBuilder } from './dbJoinBuilder'
import { createQueryChips } from './dbQueryChips'

/** The free-form query editor: run, EXPLAIN on failure, history, AI, JOIN builder and chips. */
export const openQuery = (host: DbDetailHost, s: DbServer, db: string, names: string[]): void => {
  const { showDetail, detailHead } = host
  // Relations loaded once and shared (chips, AI, and the JOIN builder).
  let relations: ForeignKey[] = []
  const relationsReady = fetchRelations(s, db).then(r => { relations = r; return r })

  const editor = document.createElement('textarea')
  editor.className = 'db-query-input'
  editor.spellcheck = false
  editor.placeholder = isMongo(s)
    ? i18nT('db.mongoPlaceholder')
    : isRedis(s)
      ? i18nT('db.redisPlaceholder')
      : i18nT('db.sqlPlaceholder')
  const runBtn = document.createElement('button')
  runBtn.className = 'db-connect'
  runBtn.textContent = i18nT('db.runShortcut')

  const history = createQueryHistory(s, db, q => { editor.value = q; editor.focus() })
  const { executeQuery, explain } = createQueryRunner(s, db, names, relationsReady)
  const aiBtn = createAiQueryButton({ s, db, names, relationsReady, executeQuery, fetchColumns })
  const joinBuilder = createJoinBuilder({
    s, names, getRelations: () => relations, relationsReady,
    onBuild: q => { editor.value = q; editor.focus() },
  })
  const chips = createQueryChips({ s, names, relationsReady, onPick: q => { editor.value = q; editor.focus() } })

  const actions = document.createElement('div')
  actions.className = 'db-query-actions'
  actions.append(runBtn, aiBtn, history.element)

  const bar = document.createElement('div')
  bar.className = 'db-query-bar'
  bar.append(editor, actions, joinBuilder, chips)

  const resultArea = document.createElement('div')
  resultArea.className = 'db-grid-scroll'
  resultArea.append(note(i18nT('db.writeAQueryAndRunIt'), 'db-detail-hint'))

  const run = async (): Promise<void> => {
    const text = editor.value.trim()
    if (!text) return
    resultArea.replaceChildren(note(i18nT('db.running'), 'db-detail-loading'))
    try {
      const result = await executeQuery(text)
      history.saveHistory(text)
      resultArea.replaceChildren(result)
    } catch (e) {
      const errEl = note(String(e), 'db-detail-error')
      const isExplainable = !isMongo(s) && !isRedis(s) && /^\s*(select|with)\b/i.test(text)
      if (!isExplainable) { resultArea.replaceChildren(errEl); return }
      const explainBtn = document.createElement('button')
      explainBtn.className = 'db-query-run'
      explainBtn.textContent = i18nT('db.seeWhyExplain')
      explainBtn.addEventListener('click', async () => {
        explainBtn.disabled = true
        explainBtn.textContent = i18nT('db.analyzing')
        try {
          resultArea.replaceChildren(await explain(text))
        } catch (e2) {
          resultArea.replaceChildren(errEl, note(String(e2), 'db-detail-error'))
        }
      })
      resultArea.replaceChildren(errEl, explainBtn)
    }
  }
  runBtn.addEventListener('click', run)
  editor.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run() }
  })

  showDetail(detailHead(i18nT('db.queryLabel', { name: db }), KIND_LABEL[s.kind]), bar, resultArea)
  editor.focus()
}
