import { open as openUrl } from '@tauri-apps/plugin-shell'
import { t as i18nT } from '../../i18n'
import type { JiraAccount } from './jiraClient'
import { note, detailHeader, field } from './jiraWidgets'

// El formulario de una cuenta: sitio, email y token. Guardar y recargar la
// lista es cosa del panel.

export interface JiraAccountFormDeps {
  showDetail: (...nodes: HTMLElement[]) => void
  saveAccount: (account: { site: string; email: string; token: string }) => Promise<void>
}

export function buildJiraAccountForm(deps: JiraAccountFormDeps): (existing?: JiraAccount) => void {
  const showConfig = (existing?: JiraAccount): void => {
    const siteF = field('Site (https://tuorg.atlassian.net)', existing?.site ?? '')
    const emailF = field('Email', existing?.email ?? '')
    const tokenF = field('API token', existing?.token ?? '', 'password')
    const hint = document.createElement('a')
    hint.className = 'jira-hint-link'
    hint.textContent = i18nT('jira.generateApiToken')
    hint.addEventListener('click', () => openUrl('https://id.atlassian.com/manage-profile/security/api-tokens').catch(() => {}))
    const save = document.createElement('button')
    save.className = 'jira-primary'
    save.textContent = 'Guardar'
    const status = note('')
    save.addEventListener('click', async () => {
      const s = siteF.input.value.trim()
      const e = emailF.input.value.trim()
      const t = tokenF.input.value.trim()
      if (!s || !e || !t) { status.textContent = 'Todos los campos son obligatorios.'; return }
      try {
        await deps.saveAccount({ site: s, email: e, token: t })
      } catch (err) {
        status.textContent = String(err)
      }
    })
    const body = document.createElement('div')
    body.className = 'jira-config'
    body.append(siteF.row, emailF.row, tokenF.row, hint, save, status)
    deps.showDetail(detailHeader(existing ? 'Editar cuenta' : 'Añadir cuenta'), body)
  }
  return showConfig
}
