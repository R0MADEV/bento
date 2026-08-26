import { icon } from '../helpers/icons'
import { AI_PROVIDERS } from '../../core/ai/providers'
import { t as i18nT } from '../../i18n'
import { showContextMenu } from '../contextMenu'
import { SLASH_COMMANDS } from '../../core/ai/prompts'

// Todo el DOM del chat: el botón flotante, la cabecera con sus selectores, los
// ajustes, el hilo y la barra de entrada. Solo crea elementos y los engancha
// entre sí — quién escucha qué se decide en `aiChat.ts`, que es donde está el
// estado.

export interface AiChatDom {
  toggle: HTMLButtonElement
  modal: HTMLElement
  header: HTMLElement
  historySelect: HTMLSelectElement
  historyRefreshBtn: HTMLButtonElement
  providerSelect: HTMLSelectElement
  modeBadge: HTMLElement
  agentSelect: HTMLSelectElement
  reviewAgentBadge: HTMLElement
  modelSelect: HTMLInputElement
  modelList: HTMLDataListElement
  expandBtn: HTMLButtonElement
  settingsBtn: HTMLButtonElement
  clearBtn: HTMLButtonElement
  closeBtn: HTMLButtonElement
  settings: HTMLElement
  baseUrlInput: HTMLInputElement
  keyInput: HTMLInputElement
  systemInput: HTMLTextAreaElement
  agentExecutableInput: HTMLInputElement
  agentArgsInput: HTMLInputElement
  vaultNotice: HTMLElement
  thread: HTMLElement
  inputRow: HTMLElement
  templatesBtn: HTMLButtonElement
  input: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
}

export function buildAiChatDom(root: HTMLElement): AiChatDom {
  const toggle = document.createElement('button')
  toggle.className = 'ai-fab'
  toggle.title = i18nT('common.aiAssistantI')
  toggle.innerHTML = icon('chat')
  root.appendChild(toggle)

  const modal = document.createElement('div')
  modal.className = 'ai-modal hidden'
  root.appendChild(modal)

  // ── Header: provider + model + settings + close ──────────────────────────
  const header = document.createElement('div')
  header.className = 'ai-header'

  const historySelect = document.createElement('select')
  historySelect.className = 'ai-select ai-history-select'
  historySelect.dataset.testid = 'ai-history-select'
  historySelect.title = i18nT('common.chatHistory')

  const historyRefreshBtn = document.createElement('button')
  historyRefreshBtn.className = 'ai-icon-btn hidden'
  historyRefreshBtn.dataset.testid = 'ai-history-refresh'
  historyRefreshBtn.title = i18nT('common.updateReviewedBranch')
  historyRefreshBtn.innerHTML = icon('refresh')

  const providerSelect = document.createElement('select')
  providerSelect.className = 'ai-select'
  AI_PROVIDERS.forEach(p => {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    providerSelect.appendChild(opt)
  })
  const agentSelect = document.createElement('select')
  agentSelect.className = 'ai-select ai-agent-select hidden'
  ;[['claude', 'Claude Code'], ['opencode', 'OpenCode'], ['codex', 'Codex'], ['custom', 'Custom CLI']].forEach(([value, label]) => {
    agentSelect.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }))
  })
  const reviewAgentBadge = document.createElement('span')
  reviewAgentBadge.className = 'ai-review-agent hidden'
  reviewAgentBadge.dataset.testid = 'ai-review-agent'

  const modeBadge = document.createElement('span')
  modeBadge.className = 'ai-mode-badge'
  modeBadge.dataset.testid = 'ai-mode-badge'

  const modelSelect = document.createElement('input')
  modelSelect.className = 'ai-model'
  modelSelect.setAttribute('list', 'ai-model-list')
  modelSelect.placeholder = i18nT('common.model')
  const modelList = document.createElement('datalist')
  modelList.id = 'ai-model-list'

  const expandBtn = document.createElement('button')
  expandBtn.className = 'ai-icon-btn'
  expandBtn.title = i18nT('common.expandShrink')
  expandBtn.innerHTML = icon('expand')

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'ai-icon-btn'
  settingsBtn.title = i18nT('common.settings2')
  settingsBtn.innerHTML = icon('settings')

  const clearBtn = document.createElement('button')
  clearBtn.className = 'ai-icon-btn'
  clearBtn.dataset.testid = 'ai-history-delete'
  clearBtn.title = i18nT('common.clearCurrentConversation')
  clearBtn.innerHTML = icon('trash')

  const closeBtn = document.createElement('button')
  closeBtn.className = 'ai-icon-btn'
  closeBtn.title = i18nT('common.close')
  closeBtn.innerHTML = icon('x')

  header.append(historySelect, historyRefreshBtn, providerSelect, modeBadge, agentSelect, reviewAgentBadge, modelSelect, modelList, expandBtn, settingsBtn, clearBtn, closeBtn)

  // ── Settings: base URL + API key ─────────────────────────────────────────
  const settings = document.createElement('div')
  settings.className = 'ai-settings hidden'
  const baseUrlInput = document.createElement('input')
  baseUrlInput.className = 'ai-field'
  baseUrlInput.placeholder = i18nT('common.aiBaseUrlPlaceholder')
  const keyInput = document.createElement('input')
  keyInput.className = 'ai-field'
  keyInput.type = 'password'
  keyInput.placeholder = i18nT('common.apiKey')
  keyInput.autocomplete = 'off'
  const systemInput = document.createElement('textarea')
  systemInput.className = 'ai-field ai-system'
  systemInput.rows = 2
  systemInput.placeholder = i18nT('common.aiSystemPlaceholder')
  const agentExecutableInput = document.createElement('input')
  agentExecutableInput.className = 'ai-field ai-agent-config hidden'
  agentExecutableInput.placeholder = i18nT('common.customExecutable')
  const agentArgsInput = document.createElement('input')
  agentArgsInput.className = 'ai-field ai-agent-config hidden'
  agentArgsInput.placeholder = i18nT('common.argumentsSpaceSeparated')
  const vaultNotice = document.createElement('div')
  vaultNotice.className = 'ai-vault-notice hidden'
  settings.append(
    labeled('Prompt de sistema', systemInput),
    labeled('Base URL', baseUrlInput),
    labeled('API key', keyInput),
    labeled('Agent executable', agentExecutableInput),
    labeled('Agent arguments', agentArgsInput),
    vaultNotice,
  )

  // ── Message thread ───────────────────────────────────────────────────────
  const thread = document.createElement('div')
  thread.className = 'ai-thread'

  // ── Input bar ────────────────────────────────────────────────────────────
  const inputRow = document.createElement('div')
  inputRow.className = 'ai-input-row'
  const templatesBtn = document.createElement('button')
  templatesBtn.className = 'ai-icon-btn ai-templates'
  templatesBtn.title = i18nT('common.templatesCommands')
  templatesBtn.textContent = '/'
  const input = document.createElement('textarea')
  input.className = 'ai-input'
  input.rows = 1
  input.placeholder = i18nT('common.aiMessagePlaceholder')
  const sendBtn = document.createElement('button')
  sendBtn.className = 'ai-send'
  sendBtn.innerHTML = icon('send')
  inputRow.append(templatesBtn, input, sendBtn)

  templatesBtn.addEventListener('click', () => {
    const rect = templatesBtn.getBoundingClientRect()
    showContextMenu(rect.left, rect.top, SLASH_COMMANDS.map(c => ({
      label: `/${c.name} — ${c.label}`,
      onClick: () => { input.value = `/${c.name} `; input.focus() },
    })))
  })

  modal.append(header, settings, thread, inputRow)

  return { toggle, modal, header, historySelect, historyRefreshBtn, providerSelect, modeBadge, agentSelect, reviewAgentBadge, modelSelect, modelList, expandBtn, settingsBtn, clearBtn, closeBtn, settings, baseUrlInput, keyInput, systemInput, agentExecutableInput, agentArgsInput, vaultNotice, thread, inputRow, templatesBtn, input, sendBtn }
}

function labeled(text: string, field: HTMLElement): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'ai-field-row'
  const span = document.createElement('span')
  span.textContent = text
  wrap.append(span, field)
  return wrap
}
