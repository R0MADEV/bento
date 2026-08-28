// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  askAi: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  },
}))
vi.mock('../../../src/core/ai/agentClient', () => ({ redact: (v: string) => v }))
vi.mock('../../../src/ui/askAi', () => ({ askAi: mocks.askAi }))

import { buildReviewAiRun, type ReviewAiRunState } from '../../../src/panels/review/reviewAiRun'
import type { ReviewChangeFile } from '../../../src/panels/review/reviewFormat'
import type { AgentType } from '../../../src/core/ai/config'
import { techReviewCheckpointKey } from '../../../src/core/ai/chatHistory'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  listeners.clear()
  mocks.askAi.mockReset()
}

function makeDom() {
  return {
    aiReviewBtn: document.createElement('button') as HTMLButtonElement,
    reviewCompareAgentsToggle: Object.assign(document.createElement('input'), { type: 'checkbox' }) as HTMLInputElement,
    reviewDrawer: document.createElement('aside'),
    reviewDrawerMeta: document.createElement('span'),
    reviewDrawerBody: document.createElement('div'),
    diffView: document.createElement('div'),
  }
}

const SAMPLE_FILE: ReviewChangeFile = {
  file: 'src/a.ts', additions: 1, deletions: 1, state: 'M',
  chunk: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
} as ReviewChangeFile

interface Data {
  repoPath: string
  selectedBranch: string
  baseBranch: string
  lastFiles: ReviewChangeFile[]
  currentPrNumber: number | null
  currentPrTitle: string
  currentPrBody: string
  agents: AgentType[]
}

interface Harness {
  dom: ReturnType<typeof makeDom>
  data: Data
  state: ReviewAiRunState
  showReviewDrawer: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<Data> = {}): Harness {
  const dom = makeDom()
  const data: Data = {
    repoPath: '/repo',
    selectedBranch: 'origin/feat',
    baseBranch: 'origin/main',
    lastFiles: [SAMPLE_FILE],
    currentPrNumber: null,
    currentPrTitle: '',
    currentPrBody: '',
    agents: ['claude'],
    ...overrides,
  }
  const showReviewDrawer = vi.fn(() => { dom.reviewDrawer.classList.add('visible'); dom.reviewDrawer.classList.remove('hidden') })
  const state: ReviewAiRunState = {
    getRepoPath: () => data.repoPath,
    getSelectedBranch: () => data.selectedBranch,
    getBaseBranch: () => data.baseBranch,
    getLastFiles: () => data.lastFiles,
    getCurrentPrNumber: () => data.currentPrNumber,
    getCurrentPrTitle: () => data.currentPrTitle,
    getCurrentPrBody: () => data.currentPrBody,
    selectedReviewAgents: () => data.agents,
    showReviewDrawer,
    mkIconBtn: (cls, title) => Object.assign(document.createElement('button'), { className: cls, title }),
  }
  return { dom, data, state, showReviewDrawer }
}

const PROMPT_COMMANDS = ['review_build_prompt', 'review_build_synthesis_prompt']
const CHECKPOINT_COMMANDS = ['review_checkpoint_save', 'review_checkpoint_get']

interface FakeRun { label: string; agent?: string | null; sessionId?: string | null; report?: string | null; error?: string | null }

// El formato de la review vive en Rust (`bento_review::report`); aquí se imita
// lo justo para que el flujo del panel se pueda seguir probando sin backend.
function fakeReportCommand(cmd: string, args: Record<string, unknown> | undefined): unknown {
  if (cmd === 'review_build_overview') return 'OVERVIEW'
  if (cmd === 'review_is_retryable') return false
  if (cmd === 'review_build_document') {
    const runs = (args?.runs ?? []) as FakeRun[]
    return runs.map(run => (run.error ? `⚠️ ${run.error}` : run.report ?? '')).join('\n\n')
  }
  if (cmd === 'review_follow_up_session') {
    const runs = (args?.runs ?? []) as FakeRun[]
    const scoped = runs.slice(0, (args?.count as number) ?? runs.length).reverse()
    const found = scoped.find(run => run.sessionId)
    return { sessionId: found?.sessionId ?? null, sessionAgent: found?.agent ?? null }
  }
  return undefined
}

/// Handlers registered by `runReviewOnEngine`, keyed by event name. The real
/// backend emits these; the tests play them by hand.
const listeners = new Map<string, (event: { payload: unknown }) => void>()

/// Emits one engine event to whoever is listening for it.
function emitReview(id: string, kind: string, payload: unknown) {
  listeners.get(`review://${kind}:${id}`)?.({ payload })
}

/// The id `runReviewOnEngine` generated for the run in flight, taken from the
/// listeners it registered — the panel builds it from the commit and the clock.
function currentRunId(): string {
  // "review://batch:<id>" — the id is after the LAST colon; the scheme's own
  // colon comes first and slicing there yielded "//batch:<id>".
  const name = [...listeners.keys()][0] ?? ''
  return name.slice(name.lastIndexOf(':') + 1)
}

/// Stands in for the Rust command: replays a whole review as the engine would
/// report it, one stage per agent plus the verification when there are two.
function engineRun(reports: string[], options: { fail?: string } = {}) {
  return async () => {
    await Promise.resolve()
    const id = currentRunId()
    reports.forEach((report, index) => {
      emitReview(id, 'batch', { index: index + 1, total: reports.length, label: `Agente ${index + 1}/${reports.length}` })
      emitReview(id, 'chunk', { text: report })
    })
    if (reports.length >= 2) {
      emitReview(id, 'synthesis', {})
      emitReview(id, 'chunk', { text: 'consolidado' })
    }
    emitReview(id, 'session', { agent: 'claude', sessionId: 'sess-1' })
    if (options.fail) emitReview(id, 'error', { message: options.fail })
    emitReview(id, 'done', {})
  }
}

const REPORT_COMMANDS = ['review_build_overview', 'review_build_document', 'review_follow_up_session', 'review_is_retryable']

function mockInvoke(map: Record<string, unknown>) {
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (PROMPT_COMMANDS.includes(cmd)) return 'PROMPT'
    if (CHECKPOINT_COMMANDS.includes(cmd)) return null
    if (REPORT_COMMANDS.includes(cmd)) return fakeReportCommand(cmd, args as Record<string, unknown> | undefined)
    if (cmd === 'review_run' || cmd === 'review_cancel') return undefined
    if (cmd in map) return map[cmd]
    throw new Error(`unmocked invoke: ${cmd}`)
  })
}

// Wires aiReviewBtn.click() -> handleAiReviewClick, exactly like ReviewPanel.ts does,
// so the context-form's self-retrigger ("Revisar" clicks aiReviewBtn) works in isolation.
function makeLoader(h: Harness) {
  const loader = buildReviewAiRun(h.dom, h.state)
  h.dom.aiReviewBtn.addEventListener('click', () => { void loader.handleAiReviewClick() })
  return loader
}

describe('handleAiReviewClick guards', () => {
  it('shows an error and does nothing when there is no repo', async () => {
    setup()
    const h = makeHarness({ repoPath: '' })
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    expect(h.dom.diffView.querySelector('.review-error')?.textContent).toContain('Open a repository')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('shows an error and does nothing when there is no selected branch', async () => {
    setup()
    const h = makeHarness({ selectedBranch: '' })
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    expect(h.dom.diffView.querySelector('.review-error')?.textContent).toContain('Select a branch')
  })

  it('shows an error and does nothing when there are no changed files', async () => {
    setup()
    const h = makeHarness({ lastFiles: [] })
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    expect(h.dom.diffView.querySelector('.review-error')?.textContent).toContain('no changes')
  })

  it('requires at least two agents when compare mode is on', async () => {
    setup()
    const h = makeHarness({ agents: ['claude'] })
    h.dom.reviewCompareAgentsToggle.checked = true
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(h.dom.diffView.querySelector('.review-error')).toBeTruthy()
  })
})

describe('review context form', () => {
  it('shows the context form on first click without starting a run', async () => {
    setup()
    const h = makeHarness()
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    expect(h.dom.reviewDrawerBody.querySelector('.review-context-form')).toBeTruthy()
    expect(h.showReviewDrawer).toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('happy path', () => {
  it('runs a single-agent review end to end and shows the result', async () => {
    setup()
    const h = makeHarness()
    mockInvoke({
      review_branch_context_prepare: { path: '/wt', commit: 'abc1234', managed: true },
      review_snapshot: 'snap1',
      review_branch_context_release: undefined,
    })
    const runEngine = engineRun(['All good.'])
    const loader = makeLoader(h)
    await loader.handleAiReviewClick() // shows context form
    h.dom.reviewDrawerBody.querySelector<HTMLButtonElement>('.review-context-run')!.click()
    await vi.waitFor(() => expect(listeners.size).toBeGreaterThan(0))
    await runEngine()
    await vi.waitFor(() => expect(h.dom.reviewDrawerBody.querySelector('.review-drawer-result')).toBeTruthy())
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'review_run')).toBe(true)
    expect(mocks.askAi).toHaveBeenCalled()
    expect(h.dom.aiReviewBtn.disabled).toBe(false)
    // Guardado en el almacén compartido con el daemon y el CLI, no en localStorage.
    const saved = mocks.invoke.mock.calls.find(([cmd]) => cmd === 'review_checkpoint_save')
    expect(saved).toBeTruthy()
    expect(saved![1]).toMatchObject({ cwd: h.data.repoPath, base: h.data.selectedBranch, commit: 'abc1234' })
    expect((saved![1] as { content: string }).content).toContain('All good.')
    expect(localStorage.getItem(techReviewCheckpointKey(h.data.repoPath, h.data.selectedBranch))).toBeNull()
  })

  it('synthesizes a final report when two agents both succeed', async () => {
    setup()
    const h = makeHarness({ agents: ['claude', 'codex'] })
    h.dom.reviewCompareAgentsToggle.checked = true
    mockInvoke({
      review_branch_context_prepare: { path: '/wt', commit: 'abc1234', managed: false },
      review_snapshot: 'snap1',
    })
    const runEngine = engineRun(['informe uno', 'informe dos'])
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    h.dom.reviewDrawerBody.querySelector<HTMLButtonElement>('.review-context-run')!.click()
    await vi.waitFor(() => expect(listeners.size).toBeGreaterThan(0))
    await runEngine()
    await vi.waitFor(() => expect(h.dom.reviewDrawerBody.querySelector('.review-drawer-result')).toBeTruthy())
  })
})

describe('failure handling', () => {
  it('shows an error with no salvage when the worktree cannot be prepared', async () => {
    setup()
    const h = makeHarness()
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (PROMPT_COMMANDS.includes(cmd)) return 'PROMPT'
      if (CHECKPOINT_COMMANDS.includes(cmd)) return null
      if (REPORT_COMMANDS.includes(cmd)) return fakeReportCommand(cmd, args as Record<string, unknown> | undefined)
      if (cmd === 'review_branch_context_prepare') throw new Error('worktree busy')
      throw new Error(`unmocked: ${cmd}`)
    })
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    h.dom.reviewDrawerBody.querySelector<HTMLButtonElement>('.review-context-run')!.click()
    await vi.waitFor(() => expect(h.dom.reviewDrawerBody.textContent).toContain('worktree busy'))
    expect(h.dom.reviewDrawerBody.querySelector('.review-drawer-result')).toBeFalsy()
    expect(h.dom.aiReviewBtn.disabled).toBe(false)
  })

  it('salvages a completed run when a later step fails', async () => {
    setup()
    const h = makeHarness()
    let snapshotCalls = 0
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (PROMPT_COMMANDS.includes(cmd)) return 'PROMPT'
      if (CHECKPOINT_COMMANDS.includes(cmd)) return null
      if (REPORT_COMMANDS.includes(cmd)) return fakeReportCommand(cmd, args as Record<string, unknown> | undefined)
      if (cmd === 'review_branch_context_prepare') return { path: '/wt', commit: 'abc1234', managed: true }
      if (cmd === 'review_snapshot') {
        // Two calls now, not three: the mid-review snapshot moved into the
        // engine, so the closing one is the second.
        snapshotCalls += 1
        if (snapshotCalls <= 1) return 'snap1'
        throw new Error('snapshot failed')
      }
      if (cmd === 'review_branch_context_release') return undefined
      if (cmd === 'review_run' || cmd === 'review_cancel') return undefined
      throw new Error(`unmocked: ${cmd}`)
    })
    const runEngine = engineRun(['Partial report.'])
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    h.dom.reviewDrawerBody.querySelector<HTMLButtonElement>('.review-context-run')!.click()
    await vi.waitFor(() => expect(listeners.size).toBeGreaterThan(0))
    await runEngine()
    await vi.waitFor(() => expect(h.dom.reviewDrawerBody.querySelector('.review-drawer-result')).toBeTruthy())
    expect(h.dom.reviewDrawerBody.textContent).toContain('Incomplete review')
  })
})

describe('stop button', () => {
  it('cancels the run in the engine, not just the listener', async () => {
    setup()
    const h = makeHarness()
    mockInvoke({
      review_branch_context_prepare: { path: '/wt', commit: 'abc1234', managed: true },
      review_snapshot: 'snap1',
      review_branch_context_release: undefined,
    })
    const loader = makeLoader(h)
    await loader.handleAiReviewClick()
    h.dom.reviewDrawerBody.querySelector<HTMLButtonElement>('.review-context-run')!.click()
    const stopBtn = await vi.waitFor(() => {
      const btn = h.dom.reviewDrawerBody.querySelector<HTMLButtonElement>('.review-ai-stop-btn')
      expect(btn?.disabled).toBe(false)
      return btn!
    })
    stopBtn.click()
    // `review_cancel` is what reaches the agents; stopping only the listener
    // left them running and billing.
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'review_cancel')).toBe(true))
    emitReview(currentRunId(), 'done', {})
  })
})
