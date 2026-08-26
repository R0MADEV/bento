import { now, quote, selectStaleSummaryJobsSql } from './memoryStore.mjs'
import { generateTranscriptSummary } from './transcriptSummary.mjs'
import { resolveSummaryJob } from './summaryJobResolver.mjs'

// Above BENTO_MEMORY_HOOK_TIMEOUT_MS (5 min): a job still pending/processing
// past that margin no longer has a worker running behind it.
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BATCH_SIZE = 3

const parseMetadata = json => { try { return JSON.parse(json || '{}') } catch { return {} } }

/**
 * Retries, in a small batch, the pending/processing jobs that got stuck
 * (crashes predating the 317a9fa fix). Meant to be called at the start of
 * every session-end: drains the queue a little at a time without delaying
 * the session that triggered it.
 */
export async function sweepStaleSummaryJobs({
  runSql,
  generateSummary = generateTranscriptSummary,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  batchSize = DEFAULT_BATCH_SIZE,
}) {
  const before = new Date(Date.now() - staleAfterMs).toISOString()
  const rows = await runSql(selectStaleSummaryJobsSql(before, maxAttempts, batchSize), true)
  const results = []
  for (const row of rows || []) {
    results.push(await retryOne(row, { runSql, generateSummary }))
  }
  return results
}

async function retryOne(row, { runSql, generateSummary }) {
  await runSql(`UPDATE memory_summary_jobs SET status = 'processing', error = '', updated_at = ${quote(now())}
    WHERE project_path = ${quote(row.project_path)} AND transcript_external_id = ${quote(row.transcript_external_id)};`)

  const transcript = {
    id: row.transcript_id,
    projectPath: row.project_path,
    agent: row.agent,
    sessionId: row.session_id,
    title: row.transcript_title,
    transcript: row.transcript_text,
    source: row.transcript_source,
    externalId: row.transcript_external_id,
    createdAt: row.transcript_created_at,
  }
  const { status } = await resolveSummaryJob({ runSql, generateSummary, transcript, metadata: parseMetadata(row.metadata_json) })
  return { projectPath: row.project_path, transcriptExternalId: row.transcript_external_id, status }
}
