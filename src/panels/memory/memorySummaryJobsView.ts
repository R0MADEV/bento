import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { MemoryEntry } from '../../core/memory/MemoryEntry'
import { projectName } from '../../core/memory/memoryFormat'
import type { MemorySummaryJob } from '../../core/memory/memorySource'

export interface MemorySummaryJobsViewDeps {
  currentProject: string
  setStatus: (message?: string, entry?: MemoryEntry) => void
  /** Called with whatever the summarizer produced, so the panel can reload and select it. */
  onRegenerated: (updated: MemoryEntry | null) => Promise<void>
}

export interface MemorySummaryJobsView {
  element: HTMLElement
  reload: () => Promise<void>
}

/**
 * The queue of agent sessions waiting to be summarized into memories. Only jobs
 * the user can act on are listed; the rest are counted in the header.
 */
export function createMemorySummaryJobsView(deps: MemorySummaryJobsViewDeps): MemorySummaryJobsView {
  const { currentProject, setStatus, onRegenerated } = deps

  let summaryJobs: MemorySummaryJob[] = []

  const summaryJobsPanel = document.createElement('details')
  summaryJobsPanel.className = 'memory-summary-jobs'
  const summaryJobsTitle = document.createElement('summary')
  summaryJobsTitle.textContent = i18nT('memory.sessionSummaries')
  const summaryJobsList = document.createElement('div')
  summaryJobsList.className = 'memory-summary-jobs-list'
  summaryJobsPanel.append(summaryJobsTitle, summaryJobsList)

  const renderSummaryJobs = (): void => {
    const pending = summaryJobs.filter(job => job.status === 'pending' || job.status === 'processing')
    const failed = summaryJobs.filter(job => job.status === 'failed')
    const completed = summaryJobs.filter(job => job.status === 'completed' || job.status === 'skipped')
    summaryJobsTitle.textContent = i18nT('memory.summaryJobs', {
      pending: pending.length ? i18nT('memory.pendingCount', { count: pending.length }) : '',
      failed: failed.length ? i18nT('memory.failedCount', { count: failed.length }) : '',
      completed: completed.length ? i18nT('memory.processedCount', { count: completed.length }) : '',
    })
    summaryJobsList.innerHTML = ''
    const actionable = [...pending, ...failed]
    if (!actionable.length) {
      summaryJobsList.textContent = summaryJobs.length
        ? i18nT('memory.thereAreNoPendingOrFailedSummaries')
        : i18nT('memory.thereAreNoRecordedSessionClosuresYet')
      return
    }
    actionable.forEach(job => {
      const row = document.createElement('div')
      row.className = `memory-summary-job ${job.status}`
      const text = document.createElement('div')
      const projectLabel = projectName(job.projectPath) || i18nT('common.global')
      text.textContent = `${job.agent} · ${projectLabel} · ${job.status}${job.error ? ` · ${job.error}` : ''}`
      row.appendChild(text)
      if (job.status === 'failed' || job.status === 'pending') {
        const retry = document.createElement('button')
        retry.className = 'memory-action'
        retry.textContent = i18nT('memory.retry')
        retry.addEventListener('click', () => { void retrySummaryJob(job) })
        row.appendChild(retry)
      }
      summaryJobsList.appendChild(row)
    })
    if (failed.length) summaryJobsPanel.open = true
  }

  const reloadSummaryJobs = async (): Promise<void> => {
    try {
      summaryJobs = await invoke<MemorySummaryJob[]>('memory_summary_job_list', { projectPath: currentProject })
    } catch {
      summaryJobs = []
    }
    renderSummaryJobs()
  }

  const retrySummaryJob = async (job: MemorySummaryJob): Promise<void> => {
    try {
      setStatus(i18nT('memory.regeneratingAgent', { agent: job.agent }))
      const updated = await invoke<MemoryEntry | null>('memory_regenerate_summary', {
        projectPath: job.projectPath,
        externalId: `${job.agent}:session-summary:${job.sessionId}`,
      })
      await onRegenerated(updated)
      await reloadSummaryJobs()
      setStatus(updated ? i18nT('memory.summaryRegenerated') : i18nT('memory.theSummarizerReturnedNoReusableMemory'), updated ?? undefined)
    } catch (error) {
      await reloadSummaryJobs()
      setStatus(i18nT('memory.regenerateFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  void reloadSummaryJobs()

  return { element: summaryJobsPanel, reload: reloadSummaryJobs }
}
