/**
 * The part of a GitHub check this module reads. Structurally compatible with
 * the generated PrCheck binding, without core depending on it.
 */
export interface PrCheckSignals {
  conclusion?: string | null
  state?: string | null
  status?: string | null
}

export type PrCheckVerdict = 'failed' | 'pending' | 'passed'

const FAILED = /FAIL|ERROR|CANCEL|TIMED_OUT/i
const PENDING = /PENDING|QUEUED|IN_PROGRESS|EXPECTED/i

/**
 * How one PR check stands. GitHub reports a finished check run in `conclusion`,
 * a commit status in `state` and a running check run in `status`, so all three
 * are read in that order. Anything unrecognised counts as passed rather than
 * blocking the badge.
 */
export function classifyPrCheck(check: PrCheckSignals): PrCheckVerdict {
  const signal = check.conclusion ?? check.state ?? check.status ?? ''
  if (FAILED.test(signal)) return 'failed'
  if (PENDING.test(signal)) return 'pending'
  return 'passed'
}

export interface PrCheckSummary {
  failed: number
  pending: number
  total: number
}

/** How many of a PR's checks failed or are still running. */
export function summarisePrChecks(checks: PrCheckSignals[]): PrCheckSummary {
  const summary: PrCheckSummary = { failed: 0, pending: 0, total: checks.length }
  for (const check of checks) {
    const verdict = classifyPrCheck(check)
    if (verdict === 'failed') summary.failed++
    else if (verdict === 'pending') summary.pending++
  }
  return summary
}
