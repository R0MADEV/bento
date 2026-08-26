const MAX_TEXT_LENGTH = 20_000
const MAX_LIST_ITEMS = 100
const MAX_LIST_ITEM_LENGTH = 500
const VALID_KINDS = new Set(['decision', 'fact', 'task', 'note'])

export const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY, project_path TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL, details TEXT NOT NULL,
    tags_json TEXT NOT NULL, files_json TEXT NOT NULL, source TEXT NOT NULL,
    external_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_entries_project_updated
    ON memory_entries(project_path, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_project_external_id
    ON memory_entries(project_path, external_id) WHERE external_id <> '';
  CREATE TABLE IF NOT EXISTS memory_transcripts (
    id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent TEXT NOT NULL,
    session_id TEXT NOT NULL, title TEXT NOT NULL, transcript TEXT NOT NULL,
    summary TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_transcripts_project_updated
    ON memory_transcripts(project_path, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS memory_transcripts_project_external_id
    ON memory_transcripts(project_path, external_id) WHERE external_id <> '';
  CREATE TABLE IF NOT EXISTS memory_summary_jobs (
    id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent TEXT NOT NULL,
    session_id TEXT NOT NULL, transcript_external_id TEXT NOT NULL,
    transcript_hash TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL,
    attempts INTEGER NOT NULL, metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS memory_summary_jobs_transcript
    ON memory_summary_jobs(project_path, transcript_external_id);
  CREATE INDEX IF NOT EXISTS memory_summary_jobs_status_updated
    ON memory_summary_jobs(status, updated_at DESC);
`

export const quote = value => `'${String(value ?? '').replaceAll("'", "''")}'`
export const json = value => JSON.stringify(Array.isArray(value) ? value : [])
export const now = () => new Date().toISOString()
export const limit = value => Math.max(1, Math.min(Number(value) || 10, 50))

const trim = value => String(value ?? '').trim()
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : []).map(value => trim(value)).filter(Boolean))]

function validateText(field, value, required = false) {
  if (required && !value) throw new Error(`${field} es obligatorio`)
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${field} supera el limite de ${MAX_TEXT_LENGTH} caracteres`)
  }
}

function validateList(field, values) {
  if (values.length > MAX_LIST_ITEMS) {
    throw new Error(`${field} admite como maximo ${MAX_LIST_ITEMS} elementos`)
  }
  if (values.some(value => value.length > MAX_LIST_ITEM_LENGTH)) {
    throw new Error(`cada elemento de ${field} admite como maximo ${MAX_LIST_ITEM_LENGTH} caracteres`)
  }
}

export function normalizeProjectPath(value, fallback = process.cwd()) {
  return trim(value || fallback)
}

export function normalizeMemoryEntry(input, options = {}) {
  const createdAt = trim(input.created_at ?? input.createdAt) || options.now || now()
  const updatedAt = trim(input.updated_at ?? input.updatedAt) || createdAt
  const entry = {
    id: trim(input.id) || options.id,
    projectPath: normalizeProjectPath(input.project_path ?? input.projectPath, options.projectPath),
    kind: trim(input.kind || options.kind || 'note'),
    title: trim(input.title),
    summary: trim(input.summary),
    details: trim(input.details),
    tags: uniqueStrings(input.tags),
    files: uniqueStrings(input.files),
    source: trim(input.source || options.source || 'mcp'),
    externalId: trim(input.external_id ?? input.externalId),
    createdAt,
    updatedAt,
  }
  validateMemoryEntry(entry)
  return entry
}

export function normalizeMemoryPatch(current, patch, updatedAt = now()) {
  const entry = {
    ...current,
    kind: patch.kind === undefined ? current.kind : trim(patch.kind),
    title: patch.title === undefined ? current.title : trim(patch.title),
    summary: patch.summary === undefined ? current.summary : trim(patch.summary),
    details: patch.details === undefined ? current.details : trim(patch.details),
    tags: patch.tags === undefined ? current.tags : uniqueStrings(patch.tags),
    files: patch.files === undefined ? current.files : uniqueStrings(patch.files),
    source: patch.source === undefined ? current.source : trim(patch.source),
    externalId: patch.external_id === undefined && patch.externalId === undefined
      ? current.externalId
      : trim(patch.external_id ?? patch.externalId),
    updatedAt: trim(updatedAt) || now(),
  }
  validateMemoryEntry(entry)
  return entry
}

export function validateMemoryEntry(entry) {
  if (!VALID_KINDS.has(entry.kind)) {
    throw new Error('kind debe ser decision, fact, task o note')
  }
  validateText('id', trim(entry.id), true)
  validateText('projectPath', trim(entry.projectPath), false)
  validateText('title', entry.title, false)
  validateText('summary', entry.summary, false)
  validateText('details', entry.details, false)
  validateText('source', entry.source, true)
  validateText('externalId', entry.externalId, false)
  validateText('createdAt', entry.createdAt, true)
  validateText('updatedAt', entry.updatedAt, true)
  validateList('tags', entry.tags)
  validateList('files', entry.files)
  if (!entry.title && !entry.summary && !entry.details) {
    throw new Error('title, summary o details es obligatorio')
  }
}

export const rowToEntry = value => ({
  id: value.id,
  projectPath: value.project_path,
  kind: value.kind,
  title: value.title,
  summary: value.summary,
  details: value.details,
  tags: JSON.parse(value.tags_json || '[]'),
  files: JSON.parse(value.files_json || '[]'),
  source: value.source,
  externalId: value.external_id,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
})

export const selectByExternalIdSql = (projectPath, externalId) => `
  SELECT * FROM memory_entries
  WHERE project_path = ${quote(projectPath)} AND external_id = ${quote(externalId)}
  LIMIT 1;
`

export const insertEntrySql = entry => `
  INSERT INTO memory_entries (
    id, project_path, kind, title, summary, details,
    tags_json, files_json, source, external_id, created_at, updated_at
  ) VALUES (
    ${quote(entry.id)}, ${quote(entry.projectPath)}, ${quote(entry.kind)}, ${quote(entry.title)},
    ${quote(entry.summary)}, ${quote(entry.details)}, ${quote(json(entry.tags))}, ${quote(json(entry.files))},
    ${quote(entry.source)}, ${quote(entry.externalId)}, ${quote(entry.createdAt)}, ${quote(entry.updatedAt)}
  );
`

export const updateEntrySql = entry => `
  UPDATE memory_entries SET
    kind = ${quote(entry.kind)},
    title = ${quote(entry.title)},
    summary = ${quote(entry.summary)},
    details = ${quote(entry.details)},
    tags_json = ${quote(json(entry.tags))},
    files_json = ${quote(json(entry.files))},
    source = ${quote(entry.source)},
    external_id = ${quote(entry.externalId)},
    updated_at = ${quote(entry.updatedAt)}
  WHERE id = ${quote(entry.id)} AND project_path = ${quote(entry.projectPath)};
`

export const upsertByExternalIdSql = entry => `
  INSERT INTO memory_entries (
    id, project_path, kind, title, summary, details,
    tags_json, files_json, source, external_id, created_at, updated_at
  ) VALUES (
    ${quote(entry.id)}, ${quote(entry.projectPath)}, ${quote(entry.kind)}, ${quote(entry.title)},
    ${quote(entry.summary)}, ${quote(entry.details)}, ${quote(json(entry.tags))}, ${quote(json(entry.files))},
    ${quote(entry.source)}, ${quote(entry.externalId)}, ${quote(entry.createdAt)}, ${quote(entry.updatedAt)}
  )
  ON CONFLICT(project_path, external_id) WHERE external_id <> ''
  DO UPDATE SET
    summary = excluded.summary,
    details = excluded.details,
    tags_json = excluded.tags_json,
    files_json = excluded.files_json,
    source = excluded.source,
    updated_at = excluded.updated_at;
`

export function normalizeTranscriptEntry(input, options = {}) {
  const createdAt = trim(input.created_at ?? input.createdAt) || options.now || now()
  return {
    id: trim(input.id) || options.id,
    projectPath: normalizeProjectPath(input.project_path ?? input.projectPath, options.projectPath),
    agent: trim(input.agent || options.agent),
    sessionId: trim(input.session_id ?? input.sessionId),
    title: trim(input.title),
    transcript: trim(input.transcript),
    summary: trim(input.summary),
    source: trim(input.source || options.source || 'session-end'),
    externalId: trim(input.external_id ?? input.externalId),
    createdAt,
    updatedAt: trim(input.updated_at ?? input.updatedAt) || createdAt,
  }
}

export const upsertTranscriptSql = entry => `
  INSERT INTO memory_transcripts (
    id, project_path, agent, session_id, title, transcript,
    summary, source, external_id, created_at, updated_at
  ) VALUES (
    ${quote(entry.id)}, ${quote(entry.projectPath)}, ${quote(entry.agent)}, ${quote(entry.sessionId)},
    ${quote(entry.title)}, ${quote(entry.transcript)}, ${quote(entry.summary)}, ${quote(entry.source)},
    ${quote(entry.externalId)}, ${quote(entry.createdAt)}, ${quote(entry.updatedAt)}
  )
  ON CONFLICT(project_path, external_id) WHERE external_id <> ''
  DO UPDATE SET
    title = excluded.title,
    transcript = excluded.transcript,
    summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE memory_transcripts.summary END,
    source = excluded.source,
    updated_at = excluded.updated_at;
`

export const upsertSummaryJobSql = job => `
  INSERT INTO memory_summary_jobs (
    id, project_path, agent, session_id, transcript_external_id,
    transcript_hash, status, error, attempts, metadata_json, created_at, updated_at
  ) VALUES (
    ${quote(job.id)}, ${quote(job.projectPath)}, ${quote(job.agent)}, ${quote(job.sessionId)},
    ${quote(job.transcriptExternalId)}, ${quote(job.transcriptHash)}, ${quote(job.status || 'pending')},
    ${quote(job.error || '')}, ${Number(job.attempts) || 0}, ${quote(JSON.stringify(job.metadata || {}))},
    ${quote(job.createdAt)}, ${quote(job.updatedAt)}
  )
  ON CONFLICT(project_path, transcript_external_id)
  DO UPDATE SET
    transcript_hash = excluded.transcript_hash,
    status = CASE
      WHEN memory_summary_jobs.transcript_hash = excluded.transcript_hash
       AND memory_summary_jobs.status IN ('pending', 'processing', 'completed', 'failed', 'skipped')
      THEN memory_summary_jobs.status ELSE 'pending' END,
    error = CASE WHEN memory_summary_jobs.transcript_hash = excluded.transcript_hash
      THEN memory_summary_jobs.error ELSE '' END,
    metadata_json = excluded.metadata_json,
    updated_at = excluded.updated_at;
`

export const updateSummaryJobSql = (projectPath, transcriptExternalId, status, error = '') => `
  UPDATE memory_summary_jobs SET
    status = ${quote(status)},
    error = ${quote(String(error).slice(0, 2000))},
    attempts = attempts + 1,
    updated_at = ${quote(now())}
  WHERE project_path = ${quote(projectPath)}
    AND transcript_external_id = ${quote(transcriptExternalId)};
`

// Pending/processing jobs that have been stuck for longer than `beforeIso`,
// already joined with their transcript: everything needed to retry the
// summary without another query. `maxAttempts` cuts off infinite retries for
// a job that will never be summarizable.
export const selectStaleSummaryJobsSql = (beforeIso, maxAttempts, limitCount = 3) => `
  SELECT j.project_path, j.agent, j.session_id, j.transcript_external_id, j.metadata_json,
         t.id AS transcript_id, t.title AS transcript_title, t.transcript AS transcript_text,
         t.source AS transcript_source, t.created_at AS transcript_created_at
  FROM memory_summary_jobs j
  JOIN memory_transcripts t
    ON t.project_path = j.project_path AND t.external_id = j.transcript_external_id
  WHERE j.status IN ('pending', 'processing')
    AND j.updated_at < ${quote(beforeIso)}
    AND j.attempts < ${Number(maxAttempts) || 5}
  ORDER BY j.updated_at ASC
  LIMIT ${Math.max(1, Number(limitCount) || 3)};
`

export const selectSummaryJobSql = (projectPath, transcriptExternalId) => `
  SELECT * FROM memory_summary_jobs
  WHERE project_path = ${quote(projectPath)}
    AND transcript_external_id = ${quote(transcriptExternalId)}
  LIMIT 1;
`
