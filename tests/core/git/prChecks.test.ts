import { describe, expect, it } from 'vitest'
import { classifyPrCheck, summarisePrChecks } from '../../../src/core/git/prChecks'
import type { PrCheck } from '../../../src/panels/tasks/gitTypes'

const check = (over: Partial<PrCheck> = {}): PrCheck =>
  ({ name: 'build', context: null, conclusion: null, state: null, status: null, ...over } as PrCheck)

describe('classifyPrCheck', () => {
  it('reads a finished check run from its conclusion', () => {
    expect(classifyPrCheck(check({ conclusion: 'FAILURE', status: 'COMPLETED' }))).toBe('failed')
    expect(classifyPrCheck(check({ conclusion: 'SUCCESS', status: 'COMPLETED' }))).toBe('passed')
  })

  it('treats errors, cancellations and timeouts as failures', () => {
    ;['ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'].forEach(conclusion => {
      expect(classifyPrCheck(check({ conclusion }))).toBe('failed')
    })
  })

  it('reads a running check run from its status', () => {
    expect(classifyPrCheck(check({ status: 'IN_PROGRESS' }))).toBe('pending')
    expect(classifyPrCheck(check({ status: 'QUEUED' }))).toBe('pending')
  })

  it('reads a commit status from its state', () => {
    expect(classifyPrCheck(check({ state: 'PENDING' }))).toBe('pending')
    expect(classifyPrCheck(check({ state: 'FAILURE' }))).toBe('failed')
    expect(classifyPrCheck(check({ state: 'SUCCESS' }))).toBe('passed')
  })

  it('prefers the conclusion over the state and status', () => {
    expect(classifyPrCheck(check({ conclusion: 'FAILURE', state: 'SUCCESS', status: 'COMPLETED' }))).toBe('failed')
  })

  it('is case-insensitive', () => {
    expect(classifyPrCheck(check({ conclusion: 'failure' }))).toBe('failed')
    expect(classifyPrCheck(check({ status: 'in_progress' }))).toBe('pending')
  })

  it('counts a check it cannot read as passed, not as a failure', () => {
    expect(classifyPrCheck(check())).toBe('passed')
    expect(classifyPrCheck(check({ conclusion: 'NEUTRAL' }))).toBe('passed')
  })
})

describe('summarisePrChecks', () => {
  it('reports nothing for a PR with no checks', () => {
    expect(summarisePrChecks([])).toEqual({ failed: 0, pending: 0, total: 0 })
  })

  it('counts failures, pending and the total', () => {
    const summary = summarisePrChecks([
      check({ conclusion: 'FAILURE' }),
      check({ status: 'IN_PROGRESS' }),
      check({ conclusion: 'SUCCESS' }),
      check({ conclusion: 'TIMED_OUT' }),
    ])
    expect(summary).toEqual({ failed: 2, pending: 1, total: 4 })
  })

  it('never counts a check as both failed and pending', () => {
    const summary = summarisePrChecks([check({ conclusion: 'FAILURE', status: 'IN_PROGRESS' })])
    expect(summary.failed + summary.pending).toBe(1)
  })
})
