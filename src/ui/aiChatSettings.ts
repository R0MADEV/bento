import { AGENT_PROVIDER_ID, providerById } from '../core/ai/providers'
import { type AiConfig } from '../core/ai/config'
import { getAiKey, vaultStatus, type VaultStatus } from '../adapters/aiKeys'
import { t as i18nT } from '../i18n'
import type { AiChatDom } from './aiChatDom'

// Los ajustes del chat: volcar la configuración a los campos, leer la clave
// del Vault y avisar cuando el Vault está bloqueado o sin configurar.

export function buildAiChatSettings(dom: AiChatDom, config: () => AiConfig): {
  applyConfigToUi: () => void
  showVaultNotice: (status: VaultStatus) => void
  loadKeyField: () => Promise<void>
} {
  const cfgOf = config
  const applyConfigToUi = (): void => {
    dom.providerSelect.value = cfgOf().providerId
    dom.modelSelect.value = cfgOf().model
    dom.baseUrlInput.value = cfgOf().baseUrl
    dom.systemInput.value = cfgOf().systemPrompt
    dom.agentExecutableInput.value = cfgOf().agentExecutable ?? ''
    dom.agentArgsInput.value = cfgOf().agentArgs ?? ''
    dom.keyInput.placeholder = i18nT('common.aiKeyPlaceholder', {
      provider: providerById(cfgOf().providerId)?.label ?? i18nT('common.provider'),
    })
    refreshModelSuggestions()
    dom.agentSelect.classList.toggle('hidden', cfgOf().providerId !== 'agent')
    const showCustomAgent = cfgOf().providerId === AGENT_PROVIDER_ID && dom.agentSelect.value === 'custom'
    document.querySelectorAll('.ai-agent-config').forEach(el => el.classList.toggle('hidden', !showCustomAgent))
  }

  // Shows the Vault status and adjusts the key field accordingly.
  const showVaultNotice = (status: VaultStatus): void => {
    const msg = status === 'absent'
      ? i18nT('common.createVaultForAiKey')
      : status === 'locked'
        ? i18nT('common.unlockVaultForAiKey')
        : ''
    dom.vaultNotice.textContent = msg
    dom.vaultNotice.classList.toggle('hidden', status === 'unlocked')
    dom.keyInput.disabled = status !== 'unlocked'
  }

  // The key lives in the Vault, not in the config: it's loaded separately (async) and only if
  // the Vault is unlocked.
  const loadKeyField = async (): Promise<void> => {
    const status = await vaultStatus()
    showVaultNotice(status)
    dom.keyInput.value = status === 'unlocked' ? await getAiKey(cfgOf().providerId) : ''
  }

  function refreshModelSuggestions(): void {
    const provider = providerById(cfgOf().providerId)
    dom.modelList.innerHTML = ''
    ;(provider?.models ?? []).forEach(m => {
      const opt = document.createElement('option')
      opt.value = m
      dom.modelList.appendChild(opt)
    })
  }

  return { applyConfigToUi, showVaultNotice, loadKeyField }
}
