import { t as i18nT } from '../../i18n'
import type { DbServer } from '../../core/db/dbServer'
import { askAi, type AiQueryRunner, type AiTool } from '../../ui/askAi'
import type { ForeignKey } from './queryBuilders'
import { KIND_LABEL, isMongo, isPg, isRedis } from '../../core/db/dbEngine'
import { note } from './dbWidgets'

export interface AiQueryButtonDeps {
  s: DbServer
  db: string
  names: string[]
  relationsReady: Promise<ForeignKey[]>
  executeQuery: (query: string) => Promise<HTMLElement>
  fetchColumns: (s: DbServer, db: string, table: string) => Promise<string[]>
}

// Inline relations only up to this many; beyond it the AI asks for them with the tool.
const INLINE_RELATIONS_CAP = 50
// One column lookup may not fan out further than this.
const COLUMN_LOOKUP_CAP = 30

/**
 * Generate the query with AI: sends the schema (tables + relations) to the chat
 * and you describe in natural language what you want. The AI's query runs against
 * this database, and a failure offers "Fix with AI" with the error attached.
 */
export function createAiQueryButton(deps: AiQueryButtonDeps): HTMLButtonElement {
  const { s, db, names, relationsReady, executeQuery, fetchColumns } = deps

  const aiBtn = document.createElement('button')
  aiBtn.className = 'db-connect db-query-ai'
  aiBtn.textContent = i18nT('db.generateWithAi')
  aiBtn.addEventListener('click', async () => {
    const noun = isMongo(s) ? i18nT('db.collections') : i18nT('db.tables')
    const noun2 = isMongo(s) ? 'colecciones' : 'tablas'
    const rels = await relationsReady
    let schema = `Base de datos ${KIND_LABEL[s.kind]} "${db}".\n${noun}: ${names.join(', ')}.`
    // Inline relations only if there are few; with many, the AI requests them via the tool.
    if (rels.length && rels.length <= INLINE_RELATIONS_CAP) {
      schema += `\nRelaciones (FK): ${rels.map(f => `${f.table}.${f.column} → ${f.ref_table}.${f.ref_column}`).join('; ')}.`
    }
    const dialect = isMongo(s)
      ? 'una consulta mongosh (usa $lookup para unir colecciones relacionadas)'
      : isRedis(s)
        ? 'un comando redis-cli'
        : isPg(s)
          ? 'una consulta SQL de PostgreSQL. IMPORTANTE: entrecomilla SIEMPRE los identificadores y CADA PARTE por separado: "esquema"."tabla" (NUNCA "esquema.tabla" con el punto dentro de las comillas). Ej.: FROM "public"."client"'
          : 'una consulta SQL'
    // The runner executes the query the AI writes against this DB. If it fails, it offers
    // "Fix with AI": resends the query + the error so the model corrects it.
    const runner: AiQueryRunner = async query => {
      try {
        return await executeQuery(query)
      } catch (e) {
        const err = String(e)
        const wrap = document.createElement('div')
        wrap.className = 'db-query-fix'
        wrap.append(note(err, 'db-detail-error'))
        const fixBtn = document.createElement('button')
        fixBtn.className = 'db-connect db-query-ai'
        fixBtn.textContent = i18nT('db.fixWithAi')
        fixBtn.addEventListener('click', () => askAi(
          `La consulta falló al ejecutarse. Corrígela (usa get_columns/get_relations si hace falta) y devuélvela lista para ejecutar.\n\nConsulta:\n${query}\n\nError:\n${err}`,
          true, runner, tools,
        ))
        wrap.append(fixBtn)
        return wrap
      }
    }
    // Tools: the AI requests real columns and relations on demand (scales with many tables).
    const arrayParam = (desc: string) => ({
      type: 'object',
      properties: { tables: { type: 'array', items: { type: 'string' }, description: desc } },
      required: ['tables'],
    })
    const tableDesc = `Nombres de ${noun2}${isPg(s) ? ' (formato schema.tabla)' : ''}`
    const tools: AiTool[] = isRedis(s) ? [] : [
      {
        name: 'get_columns',
        schema: { type: 'function', function: { name: 'get_columns', description: `Columnas reales (nombre y tipo) de las ${noun2} indicadas. Úsalo antes de escribir la consulta.`, parameters: arrayParam(tableDesc) } },
        run: async args => {
          const wanted = Array.isArray(args.tables) ? (args.tables as string[]).slice(0, COLUMN_LOOKUP_CAP) : []
          const parts = await Promise.all(wanted.map(async t => `${t}: ${(await fetchColumns(s, db, t)).join(', ') || '(desconocidas)'}`))
          return parts.join('\n') || '(sin columnas)'
        },
      },
      {
        name: 'get_relations',
        schema: { type: 'function', function: { name: 'get_relations', description: `Relaciones (claves foráneas) que tocan las ${noun2} indicadas: por qué columnas unirlas (JOIN${isMongo(s) ? '/$lookup' : ''}).`, parameters: arrayParam(tableDesc) } },
        run: async args => {
          const wanted = new Set(Array.isArray(args.tables) ? (args.tables as string[]) : [])
          const relevant = rels.filter(f => wanted.has(f.table) || wanted.has(f.ref_table))
          return relevant.map(f => `${f.table}.${f.column} → ${f.ref_table}.${f.ref_column}`).join('\n') || '(sin relaciones para esas tablas)'
        },
      },
    ]
    const verb = isMongo(s) ? 'etapas $lookup' : 'los JOIN'
    const fence = isMongo(s) ? '```js' : '```sql'
    const guide = tools.length
      ? ` Usa get_columns (columnas reales) y get_relations (claves foráneas) antes de responder. Une SOLO ${noun2} con una relación real (compruébalo con get_relations) y ordena ${verb} de modo que cada tabla referenciada ya se haya introducido antes. Si la petición implica varias ${noun2}, escribe la consulta COMPLETA; no te limites a un SELECT de una sola tabla. Devuelve SIEMPRE la consulta final dentro de un único bloque de código (${fence} … \`\`\`), sin indentarlo.`
      : ''
    askAi(`${schema}\n\nEscríbeme ${dialect} para: ${guide}`, false, runner, tools)
  })

  return aiBtn
}
