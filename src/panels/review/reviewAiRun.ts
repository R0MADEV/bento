import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/helpers/icons'
import { reviewT } from './i18n'
import { t as i18nT } from '../../i18n'
import { redact } from '../../core/ai/agentClient'
import { startAgent } from '../../adapters/agentRunner'
import { agentLabel, type AgentType } from '../../core/ai/config'
import { createContextProvider, type MultiAgentReviewRun } from '../../core/ai/techReview'
import { buildReviewDocument, buildReviewOverview, isRetryableReviewError, resolveReviewFollowUpSession, type FollowUpSession } from './reviewDocument'
import { buildReviewPrompt, buildReviewSynthesisPrompt } from './reviewPrompts'
import { askAi } from '../../ui/askAi'
import { techReviewConversationKey } from '../../core/ai/chatHistory'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import type { ReviewChangeFile } from './reviewFormat'

export interface ReviewAiRunDom {
  aiReviewBtn: HTMLButtonElement
  reviewCompareAgentsToggle: HTMLInputElement
  reviewDrawer: HTMLElement
  reviewDrawerMeta: HTMLElement
  reviewDrawerBody: HTMLElement
  diffView: HTMLElement
}

export interface ReviewAiRunState {
  getRepoPath: () => string
  getSelectedBranch: () => string
  getBaseBranch: () => string
  getLastFiles: () => ReviewChangeFile[]
  getCurrentPrNumber: () => number | null
  getCurrentPrTitle: () => string
  getCurrentPrBody: () => string
  selectedReviewAgents: () => AgentType[]
  showReviewDrawer: () => void
  mkIconBtn: (cls: string, title: string, ic: string) => HTMLButtonElement
}

export interface ReviewAiRun {
  handleAiReviewClick: () => Promise<void>
}

export function buildReviewAiRun(dom: ReviewAiRunDom, state: ReviewAiRunState): ReviewAiRun {
  const { aiReviewBtn, reviewCompareAgentsToggle, reviewDrawer, reviewDrawerMeta, reviewDrawerBody, diffView } = dom

  // Optional author context typed before a review (what the branch does / what to
  // focus on). Persisted per branch and injected into the review prompt.
  const reviewContextKey = (): string => `bento.review.context:${state.getRepoPath()}:${state.getSelectedBranch()}`
  let pendingReviewContext: string | null = null
  const showReviewContextForm = (): void => {
    const form = document.createElement('div')
    form.className = 'review-context-form'
    const label = Object.assign(document.createElement('label'), { className: 'review-context-label', textContent: reviewT('contextLabel') })
    const ta = Object.assign(document.createElement('textarea'), {
      className: 'review-context-input',
      value: (() => { try { return localStorage.getItem(reviewContextKey()) ?? '' } catch { return '' } })(),
      placeholder: reviewT('contextPlaceholder'),
    })
    const runBtn = Object.assign(document.createElement('button'), { className: 'review-context-run', textContent: reviewT('review') })
    runBtn.addEventListener('click', () => {
      const value = ta.value.trim()
      try { if (value) localStorage.setItem(reviewContextKey(), value); else localStorage.removeItem(reviewContextKey()) } catch { /* storage full */ }
      pendingReviewContext = value
      aiReviewBtn.click()
    })
    const actions = Object.assign(document.createElement('div'), { className: 'review-context-actions' })
    actions.append(runBtn)
    form.append(label, ta, actions)
    reviewDrawerMeta.textContent = ''
    reviewDrawerBody.replaceChildren(form)
    state.showReviewDrawer()
    ta.focus()
  }

  const handleAiReviewClick = async (): Promise<void> => {
    const showReviewError = (message: string): void => {
      console.error('[AI Review]', message)
      const error = Object.assign(document.createElement('div'), { className: 'review-error', textContent: message })
      if (reviewDrawer.classList.contains('visible')) {
        reviewDrawerBody.replaceChildren(error)
        error.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
      diffView.prepend(error)
      error.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    const repoPath = state.getRepoPath()
    const selectedBranch = state.getSelectedBranch()
    const lastFiles = state.getLastFiles()
    if (!repoPath) { showReviewError('Open a repository first'); return }
    if (!selectedBranch) { showReviewError('Select a branch first'); return }
    if (!lastFiles.length) { showReviewError('There are no changes to review'); return }
    const reviewAgents = state.selectedReviewAgents()
    if (reviewCompareAgentsToggle.checked && reviewAgents.length < 2) {
      showReviewError(i18nT('common.reviewSelectAnotherAgent'))
      return
    }
    // First click shows the optional context form; its "Revisar" re-triggers this
    // with the context set. Reset after reading so the next review asks again.
    if (pendingReviewContext === null) { showReviewContextForm(); return }
    const reviewContext = pendingReviewContext
    pendingReviewContext = null
    const reviewRepoPath = repoPath
    const reviewBranch = selectedBranch
    const reviewBaseBranch = state.getBaseBranch()
    const reviewAgent = reviewAgents.at(-1) ?? reviewAgents[0]
    const reviewConversationKey = techReviewConversationKey(reviewRepoPath, reviewBranch)
    const reviewProjectName = reviewRepoPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? reviewRepoPath
    const reviewOverview = await buildReviewOverview({
      branch: reviewBranch,
      base: reviewBaseBranch,
      prNumber: state.getCurrentPrNumber(),
      prTitle: state.getCurrentPrTitle(),
      prBody: state.getCurrentPrBody(),
      authorContext: reviewContext,
      files: lastFiles.map(file => ({ state: file.state, file: file.file, additions: file.additions, deletions: file.deletions })),
    })
    const reviewChangedFiles = lastFiles.map(file => file.file)
    aiReviewBtn.disabled = true
    aiReviewBtn.title = reviewT('reviewing')
    const reviewEvidence: string[] = []

    // Progress box visible desde el principio
    const progressBox = document.createElement('div')
    progressBox.className = 'review-ai-progress'
    const progressHeader = document.createElement('div')
    progressHeader.className = 'review-ai-progress-header'
    const progressStatus = Object.assign(document.createElement('span'), { className: 'review-ai-progress-status', textContent: reviewT('preparingReview') })
    const progressMeta = Object.assign(document.createElement('span'), { className: 'review-ai-progress-meta' })
    const stopReviewBtn = Object.assign(document.createElement('button'), {
      className: 'review-ai-stop-btn',
      textContent: reviewT('stop'),
      disabled: true,
    })
    const progressStream = Object.assign(document.createElement('pre'), { className: 'review-ai-progress-stream' })
    const progressToggleBtn = state.mkIconBtn('review-ai-toggle-btn', 'Ocultar/mostrar la salida del agente', 'chevron-up')
    progressToggleBtn.addEventListener('click', () => {
      const collapsed = progressStream.classList.toggle('collapsed')
      progressToggleBtn.innerHTML = icon(collapsed ? 'chevron-down' : 'chevron-up')
    })
    progressHeader.append(progressStatus, progressMeta, progressToggleBtn, stopReviewBtn)
    progressBox.append(progressHeader, progressStream)
    reviewDrawerMeta.textContent = ''
    reviewDrawerBody.replaceChildren(progressBox)
    state.showReviewDrawer()
    progressBox.scrollIntoView({ block: 'start', behavior: 'smooth' })

    const startedAt = Date.now()
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000)
      const chars = progressStream.textContent?.length ?? 0
      progressMeta.textContent = chars ? reviewT('progressMeta', { chars, seconds: secs }) : `${secs}s`
    }, 500)
    // Agents run in parallel, so track every in-flight handle (not just one) to
    // cancel them all on Stop.
    const activeReviewHandles = new Set<ReturnType<typeof startAgent>>()
    let reviewStopped = false
    stopReviewBtn.addEventListener('click', async () => {
      if (reviewStopped || !activeReviewHandles.size) return
      reviewStopped = true
      stopReviewBtn.disabled = true
      progressStatus.textContent = reviewT('stoppingReview')
      await Promise.all([...activeReviewHandles].map(handle => handle.cancel().catch(() => {})))
    })

    const showResult = (content: string, reviewCommit: string, followUpSession: FollowUpSession): void => {
      // El agente de la sesión llega como texto desde Rust; aquí solo vale si es
      // uno de los que la UI sabe pintar.
      const sessionAgent = followUpSession.sessionAgent as AgentType | null
      reviewDrawerMeta.textContent = `${reviewBranch} · ${reviewCommit.slice(0, 7)}`
      reviewDrawerBody.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'review-drawer-result',
        innerHTML: renderMarkdown(content),
      }))
      state.showReviewDrawer()
      const followUpAgent = sessionAgent ?? reviewAgent
      askAi('', false, undefined, undefined, { role: 'assistant', content }, reviewRepoPath, followUpAgent, reviewConversationKey, `${reviewProjectName} · ${reviewBranch}`, reviewBranch, reviewCommit, followUpSession.sessionId ?? undefined, sessionAgent ?? undefined, reviewEvidence)
    }
    let worktree = ''
    let managedWorktree = false
    let reviewCommit = ''
    // Declared outside the try so the catch can salvage whatever completed.
    const reviewRuns: MultiAgentReviewRun[] = []
    // In-flight batches of the current agent, used to salvage a crash that
    // happens before any consolidated run lands in reviewRuns.
    let lastBatchRuns: MultiAgentReviewRun[] = []
    const reviewMeta = () => ({
      branch: reviewBranch,
      base: reviewBaseBranch,
      commit: reviewCommit,
      compareAgents: reviewCompareAgentsToggle.checked,
      fallbackAgentLabel: agentLabel(reviewAgent),
    })
    const outputRuns = (): MultiAgentReviewRun[] => (reviewRuns.length ? reviewRuns : lastBatchRuns)
    // Persist the document after every stage so a crash/reload never loses findings.
    const saveReviewCheckpoint = async (): Promise<void> => {
      const runs = outputRuns().filter(run => run.report || run.error)
      if (!runs.length || !reviewCommit) return
      const [content, followUpSession] = await Promise.all([
        buildReviewDocument(reviewMeta(), runs),
        resolveReviewFollowUpSession(runs, runs.length),
      ])
      // Saved to the store shared with the daemon and the CLI, so the review
      // also shows up in the TUI's history and on the phone.
      await invoke('review_checkpoint_save', {
        cwd: reviewRepoPath,
        base: reviewBranch,
        content,
        branch: reviewBranch,
        commit: reviewCommit,
        sessionId: followUpSession.sessionId,
        sessionAgent: followUpSession.sessionAgent,
      })
    }
    // Persistir es de fondo: si falla, en pantalla sigue estando todo.
    const persistReviewCheckpoint = (): void => { void saveReviewCheckpoint().catch(() => {}) }
    try {
      progressStatus.textContent = reviewT('creatingWorktree')
      const branchContext = await invoke<{ path: string; commit: string; managed: boolean }>('review_branch_context_prepare', {
        repoPath: reviewRepoPath,
        reference: reviewBranch,
        commit: null,
      })
      worktree = branchContext.path
      managedWorktree = branchContext.managed
      reviewCommit = branchContext.commit
      const snapshotBefore = await invoke<string>('review_snapshot', { repoPath: worktree })
      progressStatus.textContent = reviewT('gatheringContext')
      const contextProvider = createContextProvider({
        lexis: async () => {
          const content = await invoke<string>('review_lexis_context', {
            path: worktree,
            question: [
              `Build a compact review bundle for: ${reviewChangedFiles.join(', ')}`,
              'Return impact, callers, definitions, tests, risks and likely blast radius.',
              'Prefer structured evidence over prose.',
            ].join(' '),
          })
          if (!content) throw new Error('Lexis returned no context')
          return [{ path: '<lexis>', content, reason: 'reference' as const }]
        },
        direct: async () => lastFiles.map(file => ({ path: file.file, content: file.chunk, reason: 'changed' as const })),
      })
      const context = await contextProvider.collect({ repoRoot: worktree, diff: reviewOverview, changedFiles: reviewChangedFiles })
      const sharedPrompt = await buildReviewPrompt({
        project: reviewProjectName,
        base: reviewBaseBranch,
        diff: reviewOverview,
        files: [],
        contextSources: context.sources,
        lexisContext: context.snippets.filter(snippet => snippet.reason !== 'changed').map(snippet => `${snippet.path}\n${snippet.content}`).join('\n\n'),
      })
      // One full-change prompt per agent: the whole diff + as much file content as
      // fits inline (large files truncated; the agent reads the rest via its tools).
      const ONE_PASS_CONTENT_BUDGET = 150_000
      const perFileBudget = Math.max(800, Math.floor(ONE_PASS_CONTENT_BUDGET / Math.max(lastFiles.length, 1)))
      const onePassPrompt = await buildReviewPrompt({
        project: reviewProjectName,
        base: reviewBaseBranch,
        diff: reviewOverview,
        files: lastFiles.map(file => ({
          path: file.file,
          content: file.chunk.length > perFileBudget
            ? `${file.chunk.slice(0, perFileBudget)}\n[truncado; lee el resto en el worktree]`
            : file.chunk,
        })),
        contextSources: context.sources,
        lexisContext: context.snippets.filter(snippet => snippet.reason !== 'changed').map(snippet => `${snippet.path}\n${snippet.content}`).join('\n\n'),
      })
      const snapshotBeforeAgent = await invoke<string>('review_snapshot', { repoPath: worktree })
      if (snapshotBeforeAgent !== snapshotBefore) throw new Error('Repository changed while preparing the review')
      const MAX_REVIEW_ATTEMPTS = 2
      const runReviewAgent = async (agent: AgentType, prompt: string, kind: 'analysis' | 'verification' = 'analysis'): Promise<MultiAgentReviewRun> => {
        const label = agentLabel(agent)
        const run: MultiAgentReviewRun = { label, agent }
        const stageLabel = kind === 'verification' ? 'Síntesis final' : 'Análisis'
        // A transient blip (rate limit, network, generic exit) used to kill the
        // stage; retry it once. Timeouts are NOT retried (see isRetryableReviewError).
        for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
          if (reviewStopped) break
          run.error = undefined
          run.report = undefined
          let output = ''
          const handle = startAgent(
            { agent, message: prompt, history: [], projectPath: worktree, review: true },
            chunk => {
              output += chunk
              // Show the full process (bounded), and keep it pinned to the bottom.
              progressStream.textContent = output.length > 40_000 ? '…' + output.slice(-40_000) : output
              progressStream.scrollTop = progressStream.scrollHeight
            },
            sessionId => { run.sessionId = sessionId },
            message => { run.error = message },
            tool => {
              const safeTool = redact(tool).slice(0, 1_000)
              if (!reviewEvidence.includes(safeTool)) reviewEvidence.push(safeTool)
              progressStatus.textContent = `${label} · ${stageLabel}: ${safeTool}`
            },
          )
          activeReviewHandles.add(handle)
          stopReviewBtn.disabled = false
          try {
            await handle.ready
            // `completed` resolves right after the done/error callback has already
            // run synchronously, so run.error / run.sessionId are set by this point.
            await handle.completed
            if (!run.error && !reviewStopped) {
              const report = output.trim()
              if (!report) throw new Error('El agente no devolvió ningún análisis')
              run.report = report
            }
          } catch (error) {
            run.error = error instanceof Error ? error.message : String(error)
          } finally {
            handle.unlisten()
            activeReviewHandles.delete(handle)
            if (!activeReviewHandles.size) stopReviewBtn.disabled = true
          }
          const worthAnotherAttempt = attempt < MAX_REVIEW_ATTEMPTS && !reviewStopped && !run.report && !!run.error
          const shouldRetry = worthAnotherAttempt && await isRetryableReviewError(run.error as string)
          if (!shouldRetry) break
          await new Promise<void>(resolve => setTimeout(resolve, 3_000 * attempt))
        }
        return run
      }

      // Each agent does ONE full-change analysis (reading files itself), all in
      // parallel. The final verifier then consolidates: the multi-agent pipeline is
      // kept; only the per-agent file batching (that made it take hours) is gone.
      progressStatus.textContent = reviewT('reviewingWithAgents', { count: reviewAgents.length })
      const agentRuns = await Promise.all(reviewAgents.map(agent => runReviewAgent(agent, onePassPrompt, 'analysis')))
      lastBatchRuns = agentRuns
      reviewRuns.push(...agentRuns.filter(run => run.report || run.error))
      persistReviewCheckpoint()

      // With ≥2 agents, one of them consolidates everyone's analysis into a final
      // report (the pipeline: each agent analyses, the last one synthesizes).
      const reportsToSynthesize = reviewRuns.filter(run => run.report).map(run => ({ label: run.label, report: run.report as string }))
      if (!reviewStopped && reportsToSynthesize.length >= 2) {
        progressStatus.textContent = reviewT('finalSynthesis')
        const verifierAgent = reviewAgents.at(-1) ?? reviewAgents[0]
        const synthesisPrompt = await buildReviewSynthesisPrompt(sharedPrompt, reportsToSynthesize)
        const synthesisRun = await runReviewAgent(verifierAgent, synthesisPrompt, 'verification')
        synthesisRun.label = 'Síntesis final'
        reviewRuns.push(synthesisRun)
        persistReviewCheckpoint()
      }

      if (reviewStopped) throw new Error('Review stopped')
      const successfulRuns = reviewRuns.filter(run => run.report)
      if (!successfulRuns.length) throw new Error('No valid review responses')

      const snapshotAfter = await invoke<string>('review_snapshot', { repoPath: worktree })
      const [content, followUpSession] = await Promise.all([
        buildReviewDocument(reviewMeta(), reviewRuns),
        resolveReviewFollowUpSession(reviewRuns, reviewRuns.length),
      ])
      persistReviewCheckpoint()
      showResult(content, reviewCommit, followUpSession)
      if (snapshotAfter !== snapshotBefore) showReviewError('Repository changed during review; findings may be stale')
    } catch (error) {
      // Never discard completed findings on failure/stop: render + persist what
      // we have and show the error as a note, instead of wiping the drawer.
      const salvaged = outputRuns().filter(run => run.report)
      if (salvaged.length) {
        persistReviewCheckpoint()
        const [content, followUpSession] = await Promise.all([
          buildReviewDocument(reviewMeta(), salvaged),
          resolveReviewFollowUpSession(salvaged, salvaged.length),
        ])
        showResult(content, reviewCommit, followUpSession)
        const note = Object.assign(document.createElement('div'), { className: 'review-error', textContent: reviewT('incompleteReview', { error: String(error) }) })
        reviewDrawerBody.prepend(note)
        note.scrollIntoView({ block: 'start', behavior: 'smooth' })
      } else {
        reviewDrawerBody.replaceChildren(); state.showReviewDrawer(); showReviewError(String(error))
      }
    }
      finally {
        clearInterval(timer)
        if (!reviewStopped) reviewDrawerMeta.textContent = reviewDrawerMeta.textContent || reviewT('title')
        if (managedWorktree) {
          await invoke('review_branch_context_release', { path: worktree }).catch(error => showReviewError(String(error)))
        }
        aiReviewBtn.disabled = false
        aiReviewBtn.title = reviewT('aiReview')
      }
  }

  return { handleAiReviewClick }
}
