#!/usr/bin/env node

// Local MCP server shared by Claude Code, Codex and OpenCode. It deliberately
// uses Bento's SQLite file directly, so every client sees the same memory.
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  MEMORY_SCHEMA,
  insertEntrySql,
  limit,
  normalizeMemoryEntry,
  normalizeMemoryPatch,
  normalizeProjectPath,
  rowToEntry,
  selectByExternalIdSql,
  updateEntrySql,
} from './lib/memoryStore.mjs'
import { collectSessionMetadata } from './lib/sessionCapture.mjs'
import { defaultMemoryDbPath, sqliteBinary } from './lib/memoryPaths.mjs'

const dbPath = defaultMemoryDbPath()

const projectPathFor = args => collectSessionMetadata(normalizeProjectPath(args.project_path)).projectPath

async function sql(statement, read = false) {
  await mkdir(dirname(dbPath), { recursive: true })
  const input = `.timeout 5000\n${MEMORY_SCHEMA}\n${statement}\n`
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(sqliteBinary(), read ? ['-json', dbPath] : [dbPath])
    let output = ''
    let errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(errors.trim() || `sqlite3 termino con codigo ${code}`)))
    child.stdin.end(input)
  })
  return read && stdout.trim() ? JSON.parse(stdout) : []
}

async function list(args) {
  const projectPath = projectPathFor(args)
  const rows = await sql(
    `SELECT * FROM memory_entries WHERE project_path = '${projectPath.replaceAll("'", "''")}' ORDER BY updated_at DESC LIMIT ${limit(args.limit)};`,
    true,
  )
  return rows.map(rowToEntry)
}

async function search(args) {
  const query = String(args.query || '').trim().toLowerCase()
  if (!query) return list(args)
  const terms = [...new Set(query.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])].slice(0, 12)
  if (!terms.length) return list(args)
  const projectPath = projectPathFor(args)
  const haystack = "lower(title || ' ' || summary || ' ' || details || ' ' || source || ' ' || tags_json || ' ' || files_json)"
  const matches = terms.map(term => `${haystack} LIKE '%${term.replaceAll("'", "''")}%'`)
  const score = terms.map(term => {
    const safe = term.replaceAll("'", "''")
    return `(CASE WHEN lower(title) LIKE '%${safe}%' THEN 4 ELSE 0 END
      + CASE WHEN lower(files_json) LIKE '%${safe}%' THEN 3 ELSE 0 END
      + CASE WHEN lower(tags_json) LIKE '%${safe}%' THEN 3 ELSE 0 END
      + CASE WHEN ${haystack} LIKE '%${safe}%' THEN 1 ELSE 0 END)`
  }).join(' + ')
  const rows = await sql(
    `SELECT * FROM memory_entries WHERE project_path = '${projectPath.replaceAll("'", "''")}'
     AND tags_json NOT LIKE '%"archived"%' AND tags_json NOT LIKE '%"superseded"%'
     AND (${matches.join(' OR ')})
     ORDER BY (${score}) + CASE WHEN tags_json LIKE '%"pinned"%' THEN 6 ELSE 0 END
       + CASE WHEN tags_json LIKE '%"verified"%' THEN 3 ELSE 0 END DESC,
       updated_at DESC LIMIT ${Math.min(limit(args.limit), 8)};`,
    true,
  )
  return rows.map(rowToEntry)
}

async function save(args) {
  const projectPath = projectPathFor(args)
  const entry = normalizeMemoryEntry({ ...args, project_path: projectPath }, {
    id: globalThis.crypto.randomUUID(),
    source: 'mcp',
    projectPath: process.cwd(),
  })
  if (entry.externalId) {
    const existing = await sql(selectByExternalIdSql(entry.projectPath, entry.externalId), true)
    if (existing.length) return rowToEntry(existing[0])
  }
  await sql(insertEntrySql(entry))
  return entry
}

async function update(args) {
  if (!args.id) throw new Error('id es obligatorio')
  const projectPath = projectPathFor(args)
  const rows = await sql(
    `SELECT * FROM memory_entries WHERE id = '${String(args.id).replaceAll("'", "''")}' AND project_path = '${projectPath.replaceAll("'", "''")}';`,
    true,
  )
  if (!rows.length) throw new Error('memoria no encontrada')
  const current = rowToEntry(rows[0])
  const entry = normalizeMemoryPatch(current, args)
  await sql(updateEntrySql(entry))
  return entry
}

async function remove(args) {
  if (!args.id) throw new Error('id es obligatorio')
  const projectPath = projectPathFor(args)
  await sql(`DELETE FROM memory_entries WHERE id = '${String(args.id).replaceAll("'", "''")}' AND project_path = '${projectPath.replaceAll("'", "''")}';`)
  return { deleted: true, id: args.id }
}

const tools = [
  { name: 'memory_search', description: 'Busca memoria compartida de Bento. Usa la ruta absoluta del proyecto actual en project_path.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project_path: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'memory_list', description: 'Lista las memorias recientes del proyecto actual.', inputSchema: { type: 'object', properties: { project_path: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'memory_save', description: 'Guarda una decision, hecho, tarea o nota reutilizable para el proyecto actual.', inputSchema: { type: 'object', properties: { project_path: { type: 'string' }, kind: { type: 'string', enum: ['decision', 'fact', 'task', 'note'] }, title: { type: 'string' }, summary: { type: 'string' }, details: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, source: { type: 'string' }, external_id: { type: 'string' } } } },
  { name: 'memory_update', description: 'Actualiza los campos indicados de una memoria existente.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, project_path: { type: 'string' }, kind: { type: 'string', enum: ['decision', 'fact', 'task', 'note'] }, title: { type: 'string' }, summary: { type: 'string' }, details: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, source: { type: 'string' }, external_id: { type: 'string' } }, required: ['id'] } },
  { name: 'memory_delete', description: 'Elimina una memoria por id del proyecto actual.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, project_path: { type: 'string' } }, required: ['id'] } },
]

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`)
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

async function handle(message) {
  if (message.method === 'initialize') return respond(message.id, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'bento-memory', version: '1.0.0' },
    instructions: 'Al iniciar trabajo en un proyecto, usa memory_search con la tarea y la ruta absoluta del proyecto. Al terminar, usa memory_save solo para decisiones, hechos, problemas resueltos o siguientes pasos reutilizables. No guardes conversaciones completas, secretos ni notas triviales.',
  })
  if (message.method === 'tools/list') return respond(message.id, { tools })
  if (message.method === 'tools/call') {
    const args = message.params?.arguments || {}
    const name = message.params?.name
    const result = name === 'memory_search' ? await search(args)
        : name === 'memory_list' ? await list(args)
          : name === 'memory_save' ? await save(args)
            : name === 'memory_update' ? await update(args)
              : name === 'memory_delete' ? await remove(args)
                : (() => { throw new Error(`herramienta desconocida: ${name}`) })()
    return respond(message.id, text(result))
  }
  if (message.id !== undefined) fail(message.id, `metodo no soportado: ${message.method}`)
}

let requestQueue = Promise.resolve()

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const message = JSON.parse(line)
    requestQueue = requestQueue
      .then(() => handle(message))
      .catch(error => fail(message.id, error instanceof Error ? error.message : String(error)))
  }
  catch { fail(undefined, 'JSON-RPC invalido') }
})
