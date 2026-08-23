import { agentLabel, type AgentType } from '../../core/ai/config'
import { reviewT } from './i18n'
import { t as i18nT } from '../../i18n'

const REVIEW_AGENT_KEY = 'bento.review.agent'
const REVIEW_COMPARE_AGENTS_KEY = 'bento.review.compare-agents'
const REVIEW_SECONDARY_AGENT_KEY = 'bento.review.agent.secondary'
const REVIEW_TERTIARY_AGENT_KEY = 'bento.review.agent.tertiary'
const REVIEW_AGENT_TYPES: AgentType[] = ['claude', 'opencode', 'codex']

export interface ReviewAgentControls {
  reviewAgentSelect: HTMLSelectElement
  reviewCompareAgentsToggle: HTMLInputElement
  reviewCompareAgentsLabel: HTMLLabelElement
  reviewAgentHint: HTMLDivElement
  reviewSecondaryRow: HTMLDivElement
  reviewTertiaryRow: HTMLDivElement
  reviewAgentBadge: HTMLSpanElement
  selectedReviewAgents: () => AgentType[]
}

export function buildReviewAgentControls(): ReviewAgentControls {
  const reviewAgentSelect = document.createElement('select')
  reviewAgentSelect.className = 'review-agent-select'
  ;(['claude', 'opencode', 'codex'] as const).forEach(val => {
    reviewAgentSelect.appendChild(Object.assign(document.createElement('option'), {
      value: val, textContent: agentLabel(val),
    }))
  })
  reviewAgentSelect.value = localStorage.getItem(REVIEW_AGENT_KEY) ?? 'claude'
  const reviewCompareAgentsToggle = Object.assign(document.createElement('input'), {
    type: 'checkbox',
    className: 'review-agent-toggle-input',
  })
  reviewCompareAgentsToggle.checked = localStorage.getItem(REVIEW_COMPARE_AGENTS_KEY) === '1'
  reviewCompareAgentsToggle.dataset.testid = 'review-compare-agents-toggle'
  const reviewCompareAgentsLabel = document.createElement('label')
  reviewCompareAgentsLabel.className = 'review-agent-toggle'
  reviewCompareAgentsLabel.append(reviewCompareAgentsToggle, Object.assign(document.createElement('span'), {
    textContent: i18nT('common.reviewCompareAgents'),
  }))
  const reviewAgentHint = Object.assign(document.createElement('div'), { className: 'review-agent-hint' })

  const mkOptionalAgentSelect = (value: string | null, testid: string): HTMLSelectElement => {
    const select = document.createElement('select')
    select.className = 'review-agent-select review-agent-select--optional'
    select.dataset.testid = testid
    select.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: i18nT('common.reviewAgentNone') }))
    REVIEW_AGENT_TYPES.forEach(agent => {
      select.appendChild(Object.assign(document.createElement('option'), { value: agent, textContent: agentLabel(agent) }))
    })
    select.value = value && REVIEW_AGENT_TYPES.includes(value as AgentType) ? value : ''
    return select
  }

  const reviewSecondaryAgentSelect = mkOptionalAgentSelect(localStorage.getItem(REVIEW_SECONDARY_AGENT_KEY), 'review-secondary-agent')
  const reviewTertiaryAgentSelect = mkOptionalAgentSelect(localStorage.getItem(REVIEW_TERTIARY_AGENT_KEY), 'review-tertiary-agent')
  const reviewSecondaryRow = document.createElement('div')
  reviewSecondaryRow.className = 'review-agent-extra hidden'
  reviewSecondaryRow.append(Object.assign(document.createElement('span'), { className: 'review-agent-extra-label', textContent: i18nT('common.reviewAgentSecondary') }), reviewSecondaryAgentSelect)
  const reviewTertiaryRow = document.createElement('div')
  reviewTertiaryRow.className = 'review-agent-extra hidden'
  reviewTertiaryRow.append(Object.assign(document.createElement('span'), { className: 'review-agent-extra-label', textContent: i18nT('common.reviewAgentTertiary') }), reviewTertiaryAgentSelect)

  const reviewAgentBadge = document.createElement('span')
  reviewAgentBadge.className = 'review-agent-badge'
  reviewAgentBadge.dataset.testid = 'review-agent-badge'

  const selectedReviewAgents = (): AgentType[] => {
    const selected: AgentType[] = [reviewAgentSelect.value as AgentType]
    if (!reviewCompareAgentsToggle.checked) return selected
    const extras = [reviewSecondaryAgentSelect.value, reviewTertiaryAgentSelect.value]
      .filter((value): value is AgentType => REVIEW_AGENT_TYPES.includes(value as AgentType))
    return [...selected, ...extras]
  }

  const normalizeReviewAgents = (): void => {
    if (!reviewCompareAgentsToggle.checked) return
    const primary = reviewAgentSelect.value as AgentType
    if (!reviewSecondaryAgentSelect.value) {
      reviewSecondaryAgentSelect.value = primary
    }
    if (!reviewTertiaryAgentSelect.value) reviewTertiaryAgentSelect.value = primary
  }

  const syncReviewAgentUi = (): void => {
    reviewSecondaryRow.classList.toggle('hidden', !reviewCompareAgentsToggle.checked)
    reviewTertiaryRow.classList.toggle('hidden', !reviewCompareAgentsToggle.checked)
    normalizeReviewAgents()
    localStorage.setItem(REVIEW_AGENT_KEY, reviewAgentSelect.value)
    localStorage.setItem(REVIEW_COMPARE_AGENTS_KEY, reviewCompareAgentsToggle.checked ? '1' : '0')
    if (reviewSecondaryAgentSelect.value) localStorage.setItem(REVIEW_SECONDARY_AGENT_KEY, reviewSecondaryAgentSelect.value)
    else localStorage.removeItem(REVIEW_SECONDARY_AGENT_KEY)
    if (reviewTertiaryAgentSelect.value) localStorage.setItem(REVIEW_TERTIARY_AGENT_KEY, reviewTertiaryAgentSelect.value)
    else localStorage.removeItem(REVIEW_TERTIARY_AGENT_KEY)
    const agents = selectedReviewAgents().map(agentLabel)
    reviewAgentBadge.textContent = agents.length === 1
      ? i18nT('common.reviewAgentFixed', { agent: agents[0] })
      : i18nT('common.reviewAgentsFixed', { agents: agents.join(' + ') })
    reviewAgentHint.textContent = reviewCompareAgentsToggle.checked
      ? reviewT('agentModeHintCombined')
      : reviewT('agentModeHintSingle')
  }

  reviewCompareAgentsToggle.addEventListener('change', syncReviewAgentUi)
  reviewAgentSelect.addEventListener('change', syncReviewAgentUi)
  reviewSecondaryAgentSelect.addEventListener('change', syncReviewAgentUi)
  reviewTertiaryAgentSelect.addEventListener('change', syncReviewAgentUi)
  syncReviewAgentUi()

  return {
    reviewAgentSelect,
    reviewCompareAgentsToggle,
    reviewCompareAgentsLabel,
    reviewAgentHint,
    reviewSecondaryRow,
    reviewTertiaryRow,
    reviewAgentBadge,
    selectedReviewAgents,
  }
}
