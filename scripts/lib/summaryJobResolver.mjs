import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  normalizeMemoryEntry,
  normalizeTranscriptEntry,
  now,
  updateSummaryJobSql,
  upsertByExternalIdSql,
  upsertTranscriptSql,
} from './memoryStore.mjs'
import { isNoMemorySummary, isUsefulSummary } from './transcriptSummary.mjs'
import { metadataPrompt } from './sessionCapture.mjs'

/**
 * Runs the summarizer for one transcript and writes whatever it decided:
 * completed (+ the memory entry), skipped, or failed. Shared by the
 * session-end hook's own job and by the stale-job sweep, so both write
 * exactly the same outcome for the same summary.
 */
export async function resolveSummaryJob({ runSql, generateSummary, transcript, metadata }) {
  const { projectPath, externalId: transcriptExternalId, agent, sessionId } = transcript

  let summary
  try {
    summary = await generateSummary(agent, projectPath, transcript.transcript, metadataPrompt(metadata))
  } catch (error) {
    await runSql(updateSummaryJobSql(projectPath, transcriptExternalId, 'failed', error instanceof Error ? error.message : String(error)))
    return { status: 'failed' }
  }

  if (!isUsefulSummary(summary)) {
    const status = isNoMemorySummary(summary) ? 'skipped' : 'failed'
    const error = status === 'failed' ? 'El resumidor no devolvió un resultado válido.' : ''
    await runSql(updateSummaryJobSql(projectPath, transcriptExternalId, status, error))
    return { status }
  }

  const completedTranscript = normalizeTranscriptEntry({ ...transcript, summary, updated_at: now() })
  const externalId = `${agent}:session-summary:${sessionId}`
  const tags = ['session-summary', agent, metadata.branch ? `branch:${metadata.branch}` : ''].filter(Boolean)
  const entry = normalizeMemoryEntry({
    id: randomUUID(),
    project_path: projectPath,
    kind: 'note',
    title: `Resumen de sesion: ${basename(projectPath)}`,
    summary: summary.slice(0, 500),
    details: summary,
    tags,
    files: metadata.changedFiles,
    source: `${agent}-session-end`,
    external_id: externalId,
  })
  await runSql(`${upsertTranscriptSql(completedTranscript)}\n${upsertByExternalIdSql(entry)}\n${updateSummaryJobSql(projectPath, transcriptExternalId, 'completed')}`)
  return { status: 'completed', entry }
}
