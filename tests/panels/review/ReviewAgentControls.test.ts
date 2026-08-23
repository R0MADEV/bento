// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { buildReviewAgentControls } from '../../../src/panels/review/ReviewAgentControls'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
}

describe('buildReviewAgentControls', () => {
  it('defaults to a single claude agent selected', () => {
    setup()
    const { selectedReviewAgents, reviewAgentBadge } = buildReviewAgentControls()
    expect(selectedReviewAgents()).toEqual(['claude'])
    expect(reviewAgentBadge.textContent).toContain('Claude')
  })

  it('keeps secondary/tertiary rows hidden until compare mode is enabled', () => {
    setup()
    const { reviewSecondaryRow, reviewTertiaryRow } = buildReviewAgentControls()
    expect(reviewSecondaryRow.classList.contains('hidden')).toBe(true)
    expect(reviewTertiaryRow.classList.contains('hidden')).toBe(true)
  })

  it('reveals extra agent rows and normalizes them to the primary agent on compare toggle', () => {
    setup()
    const controls = buildReviewAgentControls()
    controls.reviewCompareAgentsToggle.checked = true
    controls.reviewCompareAgentsToggle.dispatchEvent(new Event('change'))

    expect(controls.reviewSecondaryRow.classList.contains('hidden')).toBe(false)
    expect(controls.reviewTertiaryRow.classList.contains('hidden')).toBe(false)
    expect(controls.selectedReviewAgents()).toEqual(['claude', 'claude', 'claude'])
  })

  it('includes explicitly chosen secondary/tertiary agents once compare mode is on', () => {
    setup()
    const controls = buildReviewAgentControls()
    controls.reviewCompareAgentsToggle.checked = true
    controls.reviewCompareAgentsToggle.dispatchEvent(new Event('change'))

    const secondary = controls.reviewSecondaryRow.querySelector('select')!
    secondary.value = 'opencode'
    secondary.dispatchEvent(new Event('change'))

    expect(controls.selectedReviewAgents()).toEqual(['claude', 'opencode', 'claude'])
    expect(controls.reviewAgentBadge.textContent).toContain('+')
  })

  it('persists the selected agent to localStorage', () => {
    setup()
    const { reviewAgentSelect } = buildReviewAgentControls()
    reviewAgentSelect.value = 'codex'
    reviewAgentSelect.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('bento.review.agent')).toBe('codex')
  })

  it('restores the previously saved agent on the next build', () => {
    setup()
    localStorage.setItem('bento.review.agent', 'opencode')
    const { reviewAgentSelect } = buildReviewAgentControls()
    expect(reviewAgentSelect.value).toBe('opencode')
  })
})
