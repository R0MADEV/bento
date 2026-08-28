import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentType } from '../../core/ai/config'
import type { MultiAgentReviewRun } from '../../core/ai/techReview'

// Driving a review from the shared Rust engine (`bento_review::engine`), the
// same one the CLI and the phone client use. The panel used to orchestrate the
// agents itself, and that pipeline drifted from the engine's: parallelism,
// lexis context and snapshots each ended up in one and not the other.
//
// The engine reports what it is doing; the runs the drawer renders are rebuilt
// from those events here, so the document, the checkpoints and the salvage on
// failure keep working exactly as before.

export interface ReviewEngineCallbacks {
  /** A stage finished: its run is complete. Used to checkpoint per stage. */
  onRun: (run: MultiAgentReviewRun, runs: MultiAgentReviewRun[]) => void
  /** Progress line for the drawer's status. */
  onStatus: (text: string) => void
  /** Agent output as it arrives, for the progress stream. */
  onChunk: (text: string) => void
}

interface BatchPayload { index: number; total: number; label: string }

/**
 * Rebuilds the runs the drawer renders from the engine's event stream.
 *
 * A `batch` opens a run and every `chunk` until the next one belongs to it —
 * the engine emits each report whole under its own marker, so the boundaries
 * are exact rather than guessed.
 */
export class ReviewRunCollector {
  readonly runs: MultiAgentReviewRun[] = []
  private current: MultiAgentReviewRun | null = null

  /** Opens a run for a stage the engine just announced. */
  startStage(label: string, agent: AgentType): void {
    this.close()
    this.current = { label, agent }
  }

  /** Opens the verification run. Its label matches what the panel showed. */
  startSynthesis(agent: AgentType): void {
    this.close()
    this.current = { label: 'Síntesis final', agent }
  }

  append(text: string): void {
    if (!this.current) return
    this.current.report = (this.current.report ?? '') + text
  }

  setSession(sessionId: string): void {
    if (this.current) this.current.sessionId = sessionId
  }

  /** An engine error belongs to the stage in flight, or stands on its own. */
  fail(message: string, agent: AgentType): void {
    if (!this.current) this.current = { label: 'Review', agent }
    this.current.error = message
  }

  /** Closes the run in flight and keeps it if it produced anything. */
  close(): MultiAgentReviewRun | null {
    const run = this.current
    this.current = null
    if (!run) return null
    if (run.report) run.report = run.report.trim()
    if (!run.report && !run.error) return null
    this.runs.push(run)
    return run
  }
}

/**
 * Runs a review on the engine and resolves with the runs it produced. The
 * returned `cancel` stops the agents themselves, not just this listener.
 */
export function runReviewOnEngine(
  args: { id: string; cwd: string; base: string; branch: string | null; agents: AgentType[]; context: string },
  callbacks: ReviewEngineCallbacks,
): { done: Promise<MultiAgentReviewRun[]>; cancel: () => void } {
  const collector = new ReviewRunCollector()
  const verifier = args.agents.at(-1) ?? args.agents[0]
  let stageAgent: AgentType = args.agents[0]
  const unlisteners: UnlistenFn[] = []

  const done = new Promise<MultiAgentReviewRun[]>(resolve => {
    const on = async <T>(kind: string, handler: (payload: T) => void): Promise<void> => {
      unlisteners.push(await listen<T>(`review://${kind}:${args.id}`, event => handler(event.payload)))
    }
    const finish = (): void => {
      collector.close()
      unlisteners.forEach(un => un())
      resolve(collector.runs)
    }

    void (async () => {
      await Promise.all([
        on<BatchPayload>('batch', ({ index, total, label }) => {
          const finished = collector.close()
          if (finished) callbacks.onRun(finished, collector.runs)
          stageAgent = args.agents[index - 1] ?? stageAgent
          collector.startStage(label, stageAgent)
          callbacks.onStatus(`${label} · ${index}/${total}`)
        }),
        on<Record<string, never>>('synthesis', () => {
          const finished = collector.close()
          if (finished) callbacks.onRun(finished, collector.runs)
          collector.startSynthesis(verifier)
          callbacks.onStatus('Síntesis final')
        }),
        on<{ text: string }>('chunk', ({ text }) => {
          collector.append(text)
          callbacks.onChunk(text)
        }),
        on<{ tool: string }>('tool', ({ tool }) => callbacks.onStatus(tool)),
        on<{ sessionId: string }>('session', ({ sessionId }) => collector.setSession(sessionId)),
        on<{ message: string }>('error', ({ message }) => collector.fail(message, stageAgent)),
        on<Record<string, never>>('done', finish),
      ])

      await invoke('review_run', {
        id: args.id,
        cwd: args.cwd,
        base: args.base,
        branch: args.branch,
        agents: args.agents,
        context: args.context,
      }).catch((error: unknown) => {
        collector.fail(error instanceof Error ? error.message : String(error), stageAgent)
        finish()
      })
    })()
  })

  return { done, cancel: () => { void invoke('review_cancel', { id: args.id }) } }
}
